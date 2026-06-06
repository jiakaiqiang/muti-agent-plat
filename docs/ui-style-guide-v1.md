# Agent Cluster UI Style Guide v1

## Reference Summary

The product uses a multi-agent collaboration cockpit style with two coordinated
surfaces:

- Chat workspace: bright enterprise IM layout with a dark icon rail, session
  list, central message stream, and right-side agent/task panels.
- Collaboration graph and workflow: dark neon command-center views with deep
  navy backgrounds, subtle grid textures, glowing cards, colored agent lanes,
  directional arrows, and compact real-time logs.

## Design Principles

- Keep collaboration state visible at all times: active task, online agents,
  execution progress, and latest handoff should be first-screen signals.
- Separate modes visually: chat is light and operational; graph/workflow is
  dark, spatial, and analytical.
- Treat agents as people-like operators: use circular avatar tokens, numbered
  badges, role labels, and color-coded status.
- Use glow sparingly for structure: active nodes, route arrows, and primary
  state only. Body panels remain readable.

## Theme Tokens

Light chat shell:

- Background: `#f4f7fb`, panel: `#ffffff`, soft panel: `#f8fbff`.
- Primary blue: `#155eef`, hover blue: `#0f4bd6`.
- Text: `#0f1f3d`, muted: `#60708f`, faint: `#94a3b8`.
- Border: `#dbe5f5`, selected border: `#8bb8ff`.
- Success: `#10b981`, warning: `#f59e0b`, danger: `#ef4444`.

Dark cockpit shell:

- Background: `#020817`, panel: `rgba(7, 18, 38, 0.88)`.
- Panel border: `rgba(80, 145, 255, 0.24)`.
- Primary neon: `#1d9bff`, cyan: `#22d3ee`, green: `#19e58f`.
- Purple: `#a855f7`, orange: `#f59e0b`.
- Text: `#eaf4ff`, muted: `#8ba4c7`.
- Glow: `0 0 28px rgba(29, 155, 255, 0.28)`.

## Layout

- Desktop chat view uses four zones: icon rail, session list, central timeline,
  right operations panel.
- Graph/workflow views keep the icon rail and right log panel, but switch the
  central canvas to dark cockpit styling.
- Main cards use `8px` radius in light mode and `10px` radius in dark canvas
  nodes where glow needs more breathing room.
- Fixed-format controls such as stage chips, avatar tokens, progress bars, and
  icon buttons must have stable dimensions to prevent layout shift.

## Components

- Icon rail: dark vertical rail, blue active indicator, white line icons, user
  profile pinned near the bottom.
- Session list: light cards with avatar cluster, group/agent count pill, last
  message preview, and selected blue outline.
- Chat messages: agent avatar on the left, sender name colored by agent lane,
  message card with soft shadow; user messages align right with pale blue
  background.
- Agent list: compact cards with avatar, role, status pill, CPU/progress meter,
  and active task summary.
- Task steps: vertical stepper with numbered states and nested checklist rows.
- Graph nodes: avatar centered in a glowing circular frame; role title,
  numbered agent badge, status pill, and color-coded border.
- Collaboration graph: keep the dark cockpit layout from the reference:
  title/task row, `Agent 阵列` heading, five fixed-position Agent cards,
  green active-task callout, connector lines, real-time status table, and a
  right-side `对话 / 消息日志` panel with message cards and a bottom input.
  Use the existing project palette/tokens; do not introduce a new color system.
- Workflow view: keep the existing project colors and dark cockpit treatment.
  Layout follows the reference: top runtime bar, left `Agents` rail with status
  legend, central workflow canvas with five colored stage cards, hub, output
  block, arrow connectors, bottom workflow progress strip, and right-side
  real-time `对话 / 任务日志` panel.

- Graph and workflow canvases: the visual content layer supports zooming from
  60% to 180% by toolbar controls and mouse wheel. Keep the zoom toolbar fixed
  to the canvas chrome; only nodes, connectors, hubs, and output blocks scale.

## Agent Colors

- Agent 01 / demand: blue `#1d9bff`.
- Agent 02 / strategy: green `#19e58f`.
- Agent 03 / creative: purple `#a855f7`.
- Agent 04 / data: orange `#f59e0b`.
- Agent 05 / execution: cyan `#22d3ee`.
- System: neutral blue-grey `#64748b`.

## Motion And Feedback

- Hover transitions: 160-220ms for border, shadow, background, and transform.
- Active graph/workflow elements may use soft pulse glow; avoid large motion.
- Respect `prefers-reduced-motion` by disabling pulse/float animations.

## Implementation Notes

- Use CSS variables in `styles.css` as the source of truth.
- Use a route/mode class on the workspace root:
  - `workspace-shell mode-chat` for light chat.
  - `workspace-shell mode-collaboration_graph` and `mode-workflow` for dark
    cockpit surfaces.
- Avoid decorative gradient orbs. Use grid textures, line work, shadows, and
  status colors to create depth.

## Chat Workspace Spec

The chat page follows the reference group-chat layout.

- Root layout: `100vh` fixed application shell with four columns: dark rail,
  conversation list, central chat workspace, and right operations panel.
- Scrolling: the shell, rail, conversation list, and right panel stay within the
  viewport. The central chat timeline alone scrolls between the top header and
  bottom composer.
- Left rail: deep navy background with an explicit vertical layout: brand mark
  at the top, a scroll-safe `rail-nav` function group in the middle, and the
  current user block pinned at the bottom. User avatar, name, and online state
  must stay together as one `rail-user` group.
- Session list: white surface, primary blue "new conversation" button, search
  field with search/filter icons, segmented tabs, selected session card with
  blue border and soft blue background.
- Header: title and summary on the left; group pill, avatar stack, member count,
  and view mode buttons on the right. The group pill/avatar stack/member count
  open the full Agent list. Do not show search or more actions in this header.
- Timeline: messages use left avatar plus white rounded bubble; user messages
  align right with pale blue bubble. Bubble width is capped for readability.
- Composer: bottom fixed white input bar, four tool icons
  (attachment/image/code/mention), and a blue circular send button.
- Right panel: Agent cards use portrait avatars, role text, status pill, current
  task, progress meter, and compact capability/RAG tags. Task execution steps
  use a numbered vertical stepper.
- Icon system: use `UiIcon.vue` backed by `@lucide/vue`; keep icon buttons
  28-42px square and line icons at 16-24px.
- Agent portraits: use `AgentPortrait.vue`; color tones match the shared agent
  palette (blue, green, purple, orange, cyan) and replace plain numeric avatars
  in the chat workspace.
