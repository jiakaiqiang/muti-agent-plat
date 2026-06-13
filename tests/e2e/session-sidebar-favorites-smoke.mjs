import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} must include ${needle}`);
  }
}

const sidebar = read('apps/web/src/components/SessionSidebar.vue');
const workspace = read('apps/web/src/components/SessionWorkspace.vue');
const store = read('apps/web/src/stores/session.ts');
const styles = read('apps/web/src/styles.css');

assertIncludes(sidebar, "type SessionTab = 'all' | 'mine' | 'favorites'", 'Session sidebar favorites tab state');
assertIncludes(sidebar, "activeTab === 'favorites'", 'Session sidebar favorites filtering');
assertIncludes(sidebar, "@contextmenu=\"openContextMenu($event, session.id)\"", 'Session sidebar right click menu');
assertIncludes(sidebar, 'session-context-menu', 'Session sidebar context menu');
assertIncludes(sidebar, "emit('toggleFavorite', sessionId)", 'Session sidebar favorite action');
assertIncludes(sidebar, '删除会话', 'Session sidebar delete action copy');
assertIncludes(sidebar, '取消收藏', 'Session sidebar unfavorite action copy');
assertIncludes(workspace, ':favorite-session-ids="sessionStore.favoriteSessionIds"', 'Workspace favorite ids binding');
assertIncludes(workspace, '@toggle-favorite="sessionStore.toggleFavoriteSession"', 'Workspace favorite action binding');

assertIncludes(store, 'favoriteSessionIds', 'Session store favorite state');
assertIncludes(store, 'toggleFavoriteSession(sessionId: string)', 'Session store favorite toggle action');
assertIncludes(store, 'localStorage', 'Session store favorite persistence');

assertIncludes(styles, '.session-context-menu', 'Session context menu styles');
assertIncludes(styles, '.session-list-item.favorite', 'Session favorite item styles');
assertIncludes(styles, 'transform: translate(-50%, -100%)', 'Session context menu should open above cursor');

console.log('session sidebar favorites smoke ok');
