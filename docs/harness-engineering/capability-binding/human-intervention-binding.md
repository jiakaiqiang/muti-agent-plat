# Human Intervention Binding

1. Call /check before a risky action.
2. If CAPABILITY_REQUIRES_CONFIRMATION appears, surface approvalKey.
3. Record reason, scope, risk, and options.
4. Call /approve after user decision.
5. Store approve_high_risk_capability evidence.
6. Execution must reference approvalKey.

## REQUIRE_USER_CONFIRMATION

When REQUIRE_USER_CONFIRMATION is enabled, high-risk action approval is mandatory even if ENABLE_HIGH_RISK_TOOLS allows the tool class.

## Examples

- tool.file_write must show path and content summary.
- tool.command_run must show command, args, cwd, and expected side effects.

## Rubric

- The confirmation reason is explicit.
- The selected option is recorded.
- The execution links back to approvalKey.
