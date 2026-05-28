# UI State E2E Skeleton from v0.1 Events

Fixture:

- `tests/fixtures/collaboration-main-chain.v0.1.json`

## Scenario: Main Chain Renders End-to-End

Given the event store receives the fixture events in order
When the session detail screen is opened
Then the default `currentViewMode` is `chat`
And the chat stream contains:

- a user `text` message from `user_message`
- a `brief` message from `brief_created`
- a `confirmation` message from `user_confirmation_requested`
- a `task` message from `task_created`
- a `rag` message from `rag_retrieved`
- a `review` message from `post_review_completed`
- a `delivery` message from `final_delivery_created`

## Scenario: Brief Confirmation State

Given events through `user_confirmation_requested`
Then `activeConfirmation(sessionId)` exists
And its `reason` is `confirm_task_brief`
And its `status` is `pending`
And the session status is `WAIT_USER_CONFIRM` or the latest status event before
execution indicates a waiting-for-confirmation state.

## Scenario: Executing User Interrupt

Given the latest status is `EXECUTING`
When a user sends a constraint message mentioning the coordinator
Then the resulting `user_message` has `priority = high`
And the routed handling plan has:

- `intent = constraint`
- `shouldPause = false`
- `requiresBriefRevision = false`
- non-empty `affectedTaskIds`
- non-empty `affectedAgentIds`

## Scenario: RAG Hit Visibility

Given a `rag_retrieved` event exists
Then the chat derivation includes a message with `messageType = rag`
And at least one Agent card includes a source summary in `usedRagSnippets`
Or the RAG chat message payload exposes `matchedChunks`.

## Scenario: SSE Reconnect Backfill

Given the event store has processed events through `evt-010`
When SSE reconnects and calls
`GET /api/sessions/:sessionId/events?afterEventId=evt-010`
Then the store appends only `evt-011` and later
And no chat message has a duplicate `rawEventId`.
