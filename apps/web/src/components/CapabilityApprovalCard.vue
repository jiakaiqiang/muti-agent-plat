<script setup lang="ts">
import { computed } from 'vue'

type PendingApproval = {
  toolId: string
  toolKey: string
  approvalId: string
  reasons: string[]
}

const props = defineProps<{
  sessionId: string
  pendingApprovals: PendingApproval[]
  approvedApprovalIds?: string[]
  busy?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{ approve: [] }>()

const approvalList = computed(() => {
  const approvedIds = new Set(props.approvedApprovalIds ?? [])
  return props.pendingApprovals.map((approval) => ({
    approvalId: approval.approvalId,
    toolKey: approval.toolKey,
    toolId: approval.toolId,
    reasons: approval.reasons.join(', '),
    approved: approvedIds.has(approval.approvalId)
  }))
})

const allApproved = computed(() => approvalList.value.every((approval) => approval.approved))
</script>

<template>
  <section class="capability-approval-card" :class="{ compact }">
    <div class="capability-approval-card__heading">
      <span class="status-dot pending"></span>
      <div>
        <h3>需要授权能力</h3>
        <p>以下能力需要用户授权后才能继续执行</p>
      </div>
    </div>

    <div class="capability-approval-card__list">
      <article
        v-for="approval in approvalList"
        :key="approval.toolId"
        class="capability-approval-item"
      >
        <div class="capability-approval-item__header">
          <strong>{{ approval.toolKey }}</strong>
          <span class="status-pill" :class="approval.approved ? 'approved' : 'pending'">
            {{ approval.approved ? '已授权' : '待授权' }}
          </span>
        </div>
        <p class="capability-approval-item__reason">{{ approval.reasons }}</p>
      </article>
    </div>

    <div class="capability-approval-card__actions">
      <button
        class="action-button primary"
        type="button"
        :disabled="busy || allApproved"
        @click="emit('approve')"
      >
        {{ allApproved ? '已全部授权' : busy ? '授权中...' : '全部授权' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.capability-approval-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--border-color, #e7e1d7);
  border-radius: 8px;
  background: var(--surface-color, #fbf9f5);
}

.capability-approval-card.compact {
  padding: 0.75rem;
  gap: 0.75rem;
}

.capability-approval-card__heading {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.capability-approval-card__heading > div {
  flex: 1;
}

.capability-approval-card__heading h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-color, #1f2421);
}

.capability-approval-card__heading p {
  margin: 0;
  font-size: 0.875rem;
  color: var(--muted-text-color, #5c635d);
}

.capability-approval-card__list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.capability-approval-item {
  padding: 0.75rem;
  border: 1px solid var(--border-color, #e7e1d7);
  border-radius: 6px;
  background: var(--background-color, #fff);
}

.capability-approval-item__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.capability-approval-item__header strong {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-color, #1f2421);
}

.capability-approval-item__reason {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted-text-color, #5c635d);
}

.capability-approval-card__actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.action-button {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border-color, #e7e1d7);
  border-radius: 999px;
  background: var(--surface-color, #fbf9f5);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.action-button.primary {
  background: var(--accent-color, #c4612f);
  color: #fff;
  border-color: var(--accent-color, #c4612f);
}

.action-button.primary:hover {
  background: var(--accent-hover, #a94e22);
  border-color: var(--accent-hover, #a94e22);
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}

.status-dot.pending {
  background: #f59e0b;
}

.status-pill {
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
}

.status-pill.pending {
  background: #fef3c7;
  color: #92400e;
}
</style>
