export const SESSION_TITLE_VISIBLE_CHARACTER_LIMIT = 10

export function truncateSessionTitle(title: string) {
  const characters = Array.from(title)
  if (characters.length <= SESSION_TITLE_VISIBLE_CHARACTER_LIMIT) return title
  return `${characters.slice(0, SESSION_TITLE_VISIBLE_CHARACTER_LIMIT).join('')}...`
}
