import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/usageDb.js', () => ({ saveRequestUsage: vi.fn(), appendRequestLog: vi.fn(), saveRequestDetail: vi.fn(), trackPendingRequest: vi.fn() }));
import { claudeToOpenAIResponse as translate } from '../../open-sse/translator/response/claude-to-openai.js';
import { canonicalizeUsage, addBufferToUsage, filterUsageForFormat } from '../../open-sse/utils/usageTracking.js';

function start(input, read, write) {
  const state = { toolCalls: new Map(), toolCallIndex: 0, serverToolBlockIndex: -1 };
  translate({ type: 'message_start', message: { id: 'synthetic', model: 'claude', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } } }, state);
  return state;
}
describe('deployment cache-accounting regression', () => {
  for (const [input, read, write] of [[237,236884,274],[10,0,500],[10,0,0],[13,22548,0]]) {
    it(`counts ${input}/${read}/${write} exactly once`, () => {
      const state=start(input,read,write);
      const chunks=translate({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:291}},state);
      const expected=input+read+write;
      const logged=canonicalizeUsage(state.usage);
      expect(logged.prompt_tokens).toBe(expected);
      expect(logged.total_tokens).toBe(expected+291);
      expect(logged.cached_tokens).toBe(read);
      expect(logged.cache_creation_input_tokens).toBe(write);
      expect(canonicalizeUsage(logged)).toEqual(logged);
      expect(chunks.at(-1).usage.prompt_tokens).toBe(expected);
      const client=filterUsageForFormat(addBufferToUsage(state.usage),'openai');
      expect(client.prompt_tokens).toBe(expected+2000);
      expect(client.cached_tokens).toBe(read);
      if(read) expect(client.prompt_tokens_details.cached_tokens).toBe(read);
      if(write) expect(client.prompt_tokens_details.cache_creation_tokens).toBe(write);
    });
  }
  it('message_stop fallback retains inclusive usage',()=>{
    const state=start(237,236884,274);
    const chunks=translate({type:'message_stop'},state);
    expect(chunks.at(-1).usage.prompt_tokens).toBe(237395);
    expect(chunks.at(-1).usage.prompt_tokens_details).toEqual({cached_tokens:236884,cache_creation_tokens:274});
  });
  it('explicit zero cache updates replace previous cache values',()=>{
    const state=start(13,22548,500);
    translate({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:20,output_tokens:3,cache_read_input_tokens:0,cache_creation_input_tokens:0}},state);
    expect(canonicalizeUsage(state.usage)).toMatchObject({prompt_tokens:20,completion_tokens:3,cached_tokens:0,cache_creation_input_tokens:0});
  });
  it('preserves thinking patch, text streaming and tool argument streaming',()=>{
    const state=start(10,500,0);
    const chunks=[];
    const feed=e=>chunks.push(...(translate(e,state)||[]));
    feed({type:'content_block_start',index:0,content_block:{type:'thinking'}});
    feed({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'reasoning'}});
    feed({type:'content_block_stop',index:0});
    feed({type:'content_block_start',index:1,content_block:{type:'text'}});
    feed({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'answer'}});
    feed({type:'content_block_stop',index:1});
    feed({type:'content_block_start',index:2,content_block:{type:'tool_use',id:'tool_1',name:'read'}});
    feed({type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"path":"x"}'}});
    feed({type:'content_block_stop',index:2});
    feed({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}});
    const deltas=chunks.map(c=>c.choices[0].delta);
    expect(deltas.some(d=>d.reasoning_content==='reasoning')).toBe(true);
    expect(deltas.filter(d=>d.content).map(d=>d.content).join('')).toBe('answer');
    expect(deltas.some(d=>d.tool_calls?.[0]?.function?.arguments==='{"path":"x"}')).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1).usage.prompt_tokens).toBe(510);
  });
});
