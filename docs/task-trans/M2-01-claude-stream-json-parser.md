# M2-01 · Claude stream-json 帧解析器 TDD

## 目标

新建 `claude-stream-json-parser.ts`：把 Claude Code CLI 的 `--output-format stream-json` **逐行 JSON**（每行一个事件）翻译成 `RuntimeStreamFrame`。

## 依赖

M1-17（M1 全部合并）。

## 前置阅读

- Claude Code CLI 的 stream-json 事件类型：`system` / `assistant` / `user` / `tool_use` / `tool_result` / `result`
- M1-02 的 `RuntimeStreamFrame`

## 测试步骤（红）

新建 `claude-stream-json-parser.spec.ts`：

1. `{type:'assistant',message:{content:[{type:'text',text:'你好'}]}}` → `{kind:'assistant_text', text:'你好'}`
2. `{type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'read_file',input:{path:'x'}}]}}` → `{kind:'tool_use', toolCallId:'t1', tool:'read_file', input:{path:'x'}}`
3. `{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'...',is_error:false}]}}` → `{kind:'tool_result', toolCallId:'t1', tool:''/*可从上下文查*/, output:'...', isError:false}`
4. `{type:'result',subtype:'success',result:'summary',usage:{...},session_id:'s1'}` → `{kind:'result', payload:'summary', usage, cliSessionId:'s1'}`
5. `{type:'system',subtype:'init'}` → `{kind:'system', subtype:'init', raw}`

## 实现要点（绿）

- `parseClaudeLine(line: string): RuntimeStreamFrame[]`（一行可能产多帧，比如 assistant.content 数组）
- `Parser` 类维护 tool_use id → tool name 的短期 map，让 tool_result 帧带上 tool 名（便于事件展示）
- 空行 / 非 JSON 行 → 跳过（返回空数组）

## 验收目标

- [ ] `claude-stream-json-parser.ts` + `.spec.ts`
- [ ] 5 用例绿
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M2-01): Claude stream-json → RuntimeStreamFrame 解析器 TDD
```
