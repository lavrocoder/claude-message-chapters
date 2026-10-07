import type { On, TurnStepChunk } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const CHAPTER_TOOL = 'mcp__ccd_session__mark_chapter'

type Calls = { model: number }

/** Заглушки движка: «модель» отвечает заданными кусками и считает свои вызовы. */
function stubEngine(on: On, response: TurnStepChunk[], calls: Calls, isDesktop = true): void {
  // В десктопе инструмент глав есть, в терминальном Claude Code — нет.
  const tools = isDesktop ? [{ name: CHAPTER_TOOL, description: 'главы', mcp: true }] : []
  on('tool.list', () => ({ value: tools }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    calls.model += 1
    for (const chunk of response) yield chunk
    const stop = response.find(c => c.kind === 'stop')
    return {
      turnId: e.turnId,
      index: e.index,
      answer: response.flatMap(c => (c.kind === 'text' ? [c.text] : [])).join(''),
      toolUses: [],
      stopReason: stop?.kind === 'stop' ? stop.stopReason : null,
      usage: null,
    }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
}

const step = (index: number) => ({ turnId: 't1', index, model: 'claude-test', messageCount: 1 })
const prompt = (text: string, turnId?: string) =>
  ({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) }) as const
const TEXT_ANSWER: TurnStepChunk[] = [
  { kind: 'text', index: 0, text: 'Привет!' },
  { kind: 'stop', stopReason: 'end_turn', usage: null },
]

async function collect(stream: AsyncIterable<TurnStepChunk>): Promise<TurnStepChunk[]> {
  const out: TurnStepChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('первый шаг хода — только глава, без запроса к модели', async ($, on) => {
  const calls = { model: 0 }
  stubEngine(on, TEXT_ANSWER, calls)
  await $.prompt.submit(prompt('Привет'))
  const first = await collect($.turn.step(step(0)))

  expect(calls.model).toBe(0)
  expect(first.map(c => c.kind)).toEqual(['tool', 'input', 'stop'])
  const tool = first[0]
  expect(tool?.kind === 'tool' && tool.name).toBe(CHAPTER_TOOL)
  const input = first[1]
  expect(input?.kind === 'input' && JSON.parse(input.json)).toEqual({ title: 'Привет', summary: 'Привет' })
  const stop = first[2]
  expect(stop?.kind === 'stop' && stop.stopReason).toBe('tool_use')
})

test('следующий шаг отвечает модель как обычно', async ($, on) => {
  const calls = { model: 0 }
  stubEngine(on, TEXT_ANSWER, calls)
  await $.prompt.submit(prompt('Привет'))
  await collect($.turn.step(step(0)))
  const second = await collect($.turn.step(step(1)))

  expect(calls.model).toBe(1)
  expect(second.some(c => c.kind === 'tool')).toBe(false)
  expect(second.find(c => c.kind === 'text')?.kind).toBe('text')
})

test('слэш-команда главы не даёт', async ($, on) => {
  const calls = { model: 0 }
  stubEngine(on, TEXT_ANSWER, calls)
  await $.prompt.submit(prompt('/usage'))
  const first = await collect($.turn.step(step(0)))
  expect(calls.model).toBe(1)
  expect(first.some(c => c.kind === 'tool')).toBe(false)
})

test('сообщение посреди идущего хода главы не даёт', async ($, on) => {
  const calls = { model: 0 }
  stubEngine(on, TEXT_ANSWER, calls)
  await $.prompt.submit(prompt('ещё уточнение', 't0'))
  const first = await collect($.turn.step(step(0)))
  expect(calls.model).toBe(1)
  expect(first.some(c => c.kind === 'tool')).toBe(false)
})

test('без инструмента глав (терминал) плагин ничего не делает', async ($, on) => {
  const calls = { model: 0 }
  stubEngine(on, TEXT_ANSWER, calls, false)
  await $.prompt.submit(prompt('Привет'))
  const first = await collect($.turn.step(step(0)))
  expect(calls.model).toBe(1)
  expect(first.some(c => c.kind === 'tool')).toBe(false)
})
