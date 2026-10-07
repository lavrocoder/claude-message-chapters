import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import { appendLogLine, chapterTitle, isOwnMessage, oneLine } from './chapters'

/** Инструмент десктопа, вызов которого в переписке десктоп показывает как главу. */
const CHAPTER_TOOL = 'mcp__ccd_session__mark_chapter'
const LOG_FILE = 'MessageChapters/message-chapters.log'
const MAX_LOG_LINES = 2000

type Pending = { title: string; summary: string }

/**
 * Как ставить главу:
 * - `own-step` — первый шаг хода отвечает плагин (вызов главы), модель отвечает со второго:
 *   глава сразу под сообщением, у любого ответа, запроса к модели не добавляется;
 * - `append` — вызов главы дописывается в конец шага модели, который и так вызывает
 *   инструменты: запасной способ, если API не примет шаг, сделанный плагином.
 */
type Mode = 'own-step' | 'append'

let logPath: string | undefined
let logQueue: Promise<void> = Promise.resolve()
let mode: Mode = 'own-step'
/** Глава, которую надо поставить в ближайшем ходе. */
let pending: Pending | undefined
/** id хода, в котором первый шаг сделал плагин: если ход упадёт — переходим на `append`. */
let ownStepTurnId: string | undefined
/** Есть ли в сессии инструмент глав; undefined — ещё не проверяли. */
let chapterToolAvailable: boolean | undefined

function log($: EngineInterface, message: string): void {
  const line = `${new Date().toISOString()} ${message}`
  $.ui.log(`message-chapters: ${message}`, { to: 'debug' })
  logQueue = logQueue.then(() => writeLogLine($, line))
}

async function writeLogLine($: EngineInterface, line: string): Promise<void> {
  try {
    if (logPath === undefined) {
      const base = (await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('HOME')) ?? '.'
      logPath = `${base}/${LOG_FILE}`
    }
    const old = (await $.fs.exists(logPath)) ? await $.fs.read(logPath) : ''
    await $.fs.write(logPath, appendLogLine(old, line, MAX_LOG_LINES))
  } catch (error) {
    $.ui.log(`message-chapters: не удалось записать лог: ${String(error)}`, { to: 'debug' })
  }
}

/** id вызова инструмента в формате API: toolu_ и 24 случайных символа. */
function toolUseId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `toolu_${Array.from(bytes, b => alphabet[b % alphabet.length]).join('')}`
}

/** Куски потока, которые составляют вызов главы в блоке index. */
function chapterChunks(index: number, chapter: Pending): TurnStepChunk[] {
  return [
    { kind: 'tool', index, id: toolUseId(), name: CHAPTER_TOOL },
    { kind: 'input', index, json: JSON.stringify(chapter) },
  ]
}

/**
 * Есть ли в сессии инструмент глав: он есть только в Claude Desktop. В терминальном
 * Claude Code вызов несуществующего инструмента дал бы ошибку на каждом ходу.
 * Проверяется один раз за загрузку модуля.
 */
async function hasChapterTool($: EngineInterface): Promise<boolean> {
  if (chapterToolAvailable === undefined) {
    try {
      chapterToolAvailable = (await $.tool.list()).some(tool => tool.name === CHAPTER_TOOL)
    } catch (error) {
      log($, `не удалось получить список инструментов: ${String(error)}`)
      return false
    }
    log($, chapterToolAvailable ? 'инструмент глав есть — главы включены' : 'инструмента глав нет (не Claude Desktop) — главы выключены')
  }
  return chapterToolAvailable
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!(await hasChapterTool($))) {
      pending = undefined
      return next(e)
    }
    // Сообщение, отправленное посреди идущего хода, вливается в него: главу не ставим.
    const title = isOwnMessage(e) && e.turnId === undefined ? chapterTitle(e.text) : null
    pending = title === null ? undefined : { title, summary: oneLine(e.text, 200) }
    log($, pending ? `ждёт главы (${mode}): «${pending.title}»` : `без главы (источник ${e.origin?.kind}, ход ${e.turnId ?? 'новый'})`)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || pending === undefined) {
      return yield* next(e)
    }

    if (mode === 'own-step' && e.index === 0) {
      // Первый шаг отвечаем сами — только вызовом главы, без запроса к модели.
      const chapter = pending
      pending = undefined
      ownStepTurnId = e.turnId
      for (const chunk of chapterChunks(0, chapter)) yield chunk
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      log($, `глава «${chapter.title}» поставлена первым шагом хода`)
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [{ name: CHAPTER_TOOL, input: chapter }],
        stopReason: 'tool_use',
        usage: null,
      }
    }

    // Запасной способ: дописать вызов главы к шагу модели, который и так вызывает инструменты.
    let lastIndex = -1
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop' && pending !== undefined && chunk.stopReason === 'tool_use') {
        const chapter = pending
        pending = undefined
        for (const extra of chapterChunks(lastIndex + 1, chapter)) yield extra
        log($, `глава «${chapter.title}» дописана к шагу ${e.index}`)
      } else if (chunk.kind !== 'engine' && chunk.kind !== 'stop') {
        lastIndex = Math.max(lastIndex, chunk.index)
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.turnId === ownStepTurnId && e.reason === 'error' && mode === 'own-step') {
        mode = 'append'
        log($, 'ход с главой первым шагом упал с ошибкой API — до конца сессии главы дописываются к шагам с инструментами')
        $.ui.toast('message-chapters: API не принял главу первым шагом, переключаюсь на запасной способ. Отправьте сообщение ещё раз.')
      }
      if (pending !== undefined) {
        log($, `ход закончился без вызовов инструментов — глава «${pending.title}» не поставлена`)
        pending = undefined
      }
      ownStepTurnId = undefined
    }

    return next(e)
  })
}
