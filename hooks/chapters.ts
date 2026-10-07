/** Откуда приходят сообщения, которые написал сам пользователь (поле ввода, телефон, десктоп). */
const OWN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

/** Самое длинное название главы, которое принимает оглавление десктопа (меньше 40 символов). */
const CHAPTER_TITLE_MAX = 39

/**
 * Сообщение написал сам пользователь, а не фоновая задача, агент или другая сессия.
 * Без источника сообщение по правилам движка считается пользовательским.
 */
export function isOwnMessage(props: { origin?: { kind: string } }): boolean {
  return props.origin === undefined || OWN_ORIGINS.has(props.origin.kind)
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Текст в одну строку не длиннее max символов, с многоточием при обрезке. */
export function oneLine(text: string, max: number): string {
  const flat = normalize(text)
  if (max < 1) return ''
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Название главы для сообщения: начало текста в одну строку.
 * null — главу не ставить: пустое сообщение или слэш-команда.
 */
export function chapterTitle(text: string): string | null {
  const flat = normalize(text)
  if (flat === '' || flat.startsWith('/')) return null
  return oneLine(flat, CHAPTER_TITLE_MAX)
}

/** Дописывает строку к содержимому лога и оставляет только последние maxLines строк. */
export function appendLogLine(old: string, line: string, maxLines: number): string {
  const lines = old.split('\n').filter(l => l !== '')
  lines.push(line)
  return `${lines.slice(-maxLines).join('\n')}\n`
}
