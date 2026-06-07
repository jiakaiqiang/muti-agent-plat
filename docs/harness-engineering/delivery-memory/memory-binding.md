# Memory Binding

## 作用域绑定

| MemoryScope | meaning | rule |
| --- | --- | --- |
| short_term | temporary working context | Do not treat as long-term truth. |
| session | facts useful in the current delivery | Must have sourceEventId or artifact reference. |
| long_term_candidate | possible reusable memory | Needs confirmMemory before reuse as stable knowledge. |

## createContextPack and relevantMemories

createContextPack may inject relevantMemories, but candidate memories must be labeled and must not override confirmed project knowledge.

## confirmMemory

confirmMemory means the memory is reusable, confirmed, scoped, and safe for future agents.

## Rubric

- sourceEventId exists.
- Scope is explicit.
- Stale condition is stated.
