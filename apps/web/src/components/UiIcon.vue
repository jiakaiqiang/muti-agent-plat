<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string
    size?: number
    strokeWidth?: number
  }>(),
  {
    size: 18,
    strokeWidth: 2.2
  }
)
</script>

<template>
  <svg
    class="ui-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'message'">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </template>
    <template v-else-if="name === 'workflow'">
      <rect x="3" y="4" width="6" height="6" rx="2" />
      <rect x="15" y="14" width="6" height="6" rx="2" />
      <path d="M9 7h4a3 3 0 0 1 3 3v4" />
      <path d="M12 17H9a3 3 0 0 1-3-3v-4" />
    </template>
    <template v-else-if="name === 'graph'">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="7" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M8.8 7.1 15.2 6.9" />
      <path d="m7.8 8.5 3 7" />
      <path d="m16.4 9.5-3 6.2" />
    </template>
    <template v-else-if="name === 'database'">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="m4.9 4.9 2.1 2.1" />
      <path d="m17 17 2.1 2.1" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="m4.9 19.1 2.1-2.1" />
      <path d="m17 7 2.1-2.1" />
    </template>
    <template v-else-if="name === 'debug'">
      <path d="M8 3h8" />
      <path d="M9 3v4" />
      <path d="M15 3v4" />
      <rect x="5" y="7" width="14" height="14" rx="4" />
      <path d="M3 13h4" />
      <path d="M17 13h4" />
      <path d="M3 17h4" />
      <path d="M17 17h4" />
      <circle cx="10" cy="13" r="1" />
      <circle cx="14" cy="13" r="1" />
      <path d="M9 17h6" />
    </template>
    <template v-else-if="name === 'bot'">
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V4" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M9 17h6" />
    </template>
    <template v-else-if="name === 'sparkles'">
      <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z" />
      <path d="m5 15 .8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8z" />
    </template>
    <template v-else-if="name === 'bell'">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </template>
    <template v-else-if="name === 'users'">
      <circle cx="9" cy="8" r="4" />
      <path d="M3 21a6 6 0 0 1 12 0" />
      <path d="M16 4.5a4 4 0 0 1 0 7" />
      <path d="M21 21a6 6 0 0 0-4.2-5.7" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </template>
    <template v-else-if="name === 'x'">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </template>
    <template v-else-if="name === 'filter'">
      <path d="M3 5h18" />
      <path d="M6 12h12" />
      <path d="M10 19h4" />
    </template>
    <template v-else-if="name === 'paperclip'">
      <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="10" r="2" />
      <path d="m21 16-5-5L5 19" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </template>
  </svg>
</template>
