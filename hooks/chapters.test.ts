import { describe, expect, test } from 'claude-code/testing'

import { appendLogLine, chapterTitle, isOwnMessage, oneLine } from './chapters'

describe('isOwnMessage', () => {
  test('свои сообщения: поле ввода, телефон, десктоп', async () => {
    expect(isOwnMessage({ origin: { kind: 'composer' } })).toBe(true)
    expect(isOwnMessage({ origin: { kind: 'bridge' } })).toBe(true)
    expect(isOwnMessage({ origin: { kind: 'sdk' } })).toBe(true)
  })

  test('сообщение без источника — пользовательское', async () => {
    expect(isOwnMessage({})).toBe(true)
  })

  test('уведомления задач, агенты и плагины — не свои', async () => {
    expect(isOwnMessage({ origin: { kind: 'task-notification' } })).toBe(false)
    expect(isOwnMessage({ origin: { kind: 'peer' } })).toBe(false)
    expect(isOwnMessage({ origin: { kind: 'plugin' } })).toBe(false)
  })
})

describe('oneLine', () => {
  test('склеивает строки и пробелы', async () => {
    expect(oneLine('  привет\n\n  мир  ', 50)).toBe('привет мир')
  })

  test('обрезает длинный текст с многоточием', async () => {
    expect(oneLine('абвгдеёжзи', 5)).toBe('абвг…')
  })

  test('короткий текст не трогает', async () => {
    expect(oneLine('абв', 3)).toBe('абв')
  })
})

describe('chapterTitle', () => {
  test('берёт начало сообщения в одну строку', async () => {
    expect(chapterTitle('давай\n попробуй главы')).toBe('давай попробуй главы')
  })

  test('обрезает длинное сообщение короче 40 символов', async () => {
    const title = chapterTitle('Я слышал что claude desktop теперь можно кастомизировать. Это правда?')
    expect(title?.length).toBe(39)
    expect(title?.endsWith('…')).toBe(true)
  })

  test('для пустых сообщений и слэш-команд главу не ставит', async () => {
    expect(chapterTitle('   ')).toBeNull()
    expect(chapterTitle('/usage')).toBeNull()
  })
})

describe('appendLogLine', () => {
  test('дописывает строку в пустой лог', async () => {
    expect(appendLogLine('', 'a', 10)).toBe('a\n')
  })

  test('дописывает в конец существующего', async () => {
    expect(appendLogLine('a\nb\n', 'c', 10)).toBe('a\nb\nc\n')
  })

  test('держит только последние строки', async () => {
    expect(appendLogLine('a\nb\nc\n', 'd', 2)).toBe('c\nd\n')
  })
})
