const fs = require("fs/promises")
const { randomInt } = require("crypto")
const PostModel = require("../models/Post")
const Notifier = require("../utils/Notifier")
const { Type } = require("@google/genai");

class Scheduler {
  #timeoutId = null
  #channelId = null
  #nextPostTime = null

  constructor(model, bot) {
    this.model = model
    this.bot = bot
    this.lastSuccessfulPostTime = Date.now()
  }

  static logDebug(msg) { Notifier.log(`[DEBUG] ${msg}`) }
  static logInfo(msg)  { Notifier.log(`[INFO] ${msg}`) }
  static async logError(mod, err) { await Notifier.error(err, { module: mod }) }

  static ensureChannelId(id) {
    if (!id || typeof id !== "string" || !id.trim()) {
      throw new Error("channelId не задан или недействителен")
    }
  }

  static getCurrentTimeAlmaty() {
    const now = new Date()
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    })
    const [datePart, timePart] = fmt.format(now).split(", ")
    return new Date(`${datePart}T${timePart}`)
  }

  static async getRandomDelay(minM = 0, maxM = 0) {
    try {
      minM = Math.max(0, minM)
      maxM = Math.max(0, maxM)
      if (minM > maxM) [minM, maxM] = [maxM, minM]
      const minMs = minM * 60_000, maxMs = maxM * 60_000
      const d = randomInt(minMs, maxMs + 1)
      Scheduler.logDebug(`delay = ${d} ms`)
      return d
    } catch (e) {
      await Scheduler.logError("getRandomDelay", e)
      return 0
    }
  }

  static shouldSkipPost() {
    try {
      const skip = randomInt(0, 100) < 10
      Scheduler.logDebug(`shouldSkipPost → ${skip}`)
      return skip
    } catch (e) {
      Notifier.error(e, { module: "shouldSkipPost" })
      return false
    }
  }

  static async getTimeInterval() {
    try {
      const h = Scheduler.getCurrentTimeAlmaty().getHours()
      Scheduler.logDebug(`hour Almaty = ${h}`)
      if (h >= 8  && h < 16) return [5, 45]
      if (h >= 16 && h < 18) return [20, 90]
      if (h >= 18 && h < 23) return [45, 120]
      return [5, 45]
    } catch (e) {
      await Scheduler.logError("getTimeInterval", e)
      return [5, 45]
    }
  }

  static async updatePostRecord(lastPost, nextPost) {
    try {
      await PostModel.findByIdAndUpdate(
        "singleton",
        { lastPost, nextPost },
        { upsert: true }
      )
      Scheduler.logDebug(`DB updated: last=${lastPost}, next=${nextPost}`)
    } catch (e) {
      await Scheduler.logError("updatePostRecord", e)
    }
  }

  static async computeNextPostTime() {
    try {
      const doc = await PostModel.findById("singleton")
      const last = doc?.lastPost  ?? 0
      let   next = doc?.nextPost ?? 0
      const now  = Date.now()
      Scheduler.logDebug(`now=${now}, last=${last}, next=${next}`)
      if (next > now) {
        Scheduler.logInfo("используем уже запланированное")
        return next
      }
      const [min, max] = await Scheduler.getTimeInterval()
      const delay = await Scheduler.getRandomDelay(min, max)
      next = now + delay
      await Scheduler.updatePostRecord(last, next)
      Scheduler.logDebug(`новый next=${new Date(next).toISOString()}`)
      return next
    } catch (e) {
      await Scheduler.logError("computeNextPostTime", e)
      throw e
    }
  }

  // ——— полностью синхронная генерация и возврат готового текста + темы
  async generateTextFromPrompt(promptPath) {
    try {
      Scheduler.logInfo(`читаем промпт из ${promptPath}`)
      const prompt = await fs.readFile(promptPath, "utf-8")

      const systemInstruction = await fs.readFile("system.txt", "utf-8");
      const result = await this.model.models.generateContent({
        model: "gemini-2.0-flash-thinking-exp-01-21",
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 2,
          topP: 0.9,
          topK: 40,
          candidateCount: 1,
          responseLogprobs: false,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              emoji: { type: Type.STRING, nullable: false },
              quote: { type: Type.STRING, nullable: false },
              theme: { type: Type.STRING, nullable: false },
              hashtags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                nullable: false,
              },
            },
            required: ["emoji", "quote", "theme", "hashtags"],
          },
        },
      })

      // в зависимости от API
      const raw = typeof result.text === "function"
        ? await result.text()
        : result.text

      const json = JSON.parse(raw)
      const message = `${json.emoji} - ${json.quote}\n\n||${json.hashtags.join(" ")}||`
      return { message, theme: json.theme }
    } catch (e) {
      await Scheduler.logError("generateTextFromPrompt", e)
      return { message: "", theme: "" }
    }
  }

  async postQuoteToTelegram(channelId) {
    try {
      Scheduler.ensureChannelId(channelId)
      Scheduler.logInfo("генерируем цитату")
      const { message, theme } = await this.generateTextFromPrompt("./prompt.txt")
      if (!message) throw new Error("пустое сообщение")
      const full = `${message}\n\n📚 Тема цитаты: ${theme}`
      await this.bot.telegram.sendMessage(channelId, message, { parse_mode: "HTML" })
      await this.bot.telegram.sendMessage(6153453766, full, { parse_mode: "HTML" })
      Scheduler.logInfo("отправлено")
    } catch (e) {
      await Scheduler.logError("postQuoteToTelegram", e)
      throw e
    }
  }

  async _handleScheduledPost() {
    try {
      if (Scheduler.shouldSkipPost()) {
        Scheduler.logInfo("😴 пропускаем")
      } else {
        await this.postQuoteToTelegram(this.#channelId)
        await Scheduler.updatePostRecord(Date.now(), 0)
        Scheduler.logInfo("обновили lastPost")
      }
      this.lastSuccessfulPostTime = Date.now()
    } catch (e) {
      await Scheduler.logError("_handleScheduledPost", e)
    }
  }

  async schedulePost(channelId) {
    try {
      Scheduler.ensureChannelId(channelId)
      this.#channelId = channelId
      if (this.#timeoutId) clearTimeout(this.#timeoutId)

      this.#nextPostTime = await Scheduler.computeNextPostTime()
      const delay = Math.max(this.#nextPostTime - Date.now(), 0)
      Scheduler.logInfo(`следующий через ${Math.round(delay/60000)} мин`)
      this.#timeoutId = setTimeout(async () => {
        await this._handleScheduledPost()
        await this.schedulePost(channelId)
      }, delay)
    } catch (e) {
      await Scheduler.logError("schedulePost", e)
    }
  }

  async forcePost(channelId) {
    try {
      Scheduler.ensureChannelId(channelId)
      await Scheduler.updatePostRecord(Date.now(), 0)
      Scheduler.logInfo("сброс счётчика")
      await this.postQuoteToTelegram(channelId)
      this.lastSuccessfulPostTime = Date.now()
      Scheduler.logInfo("принудительно отправили")
      await this.schedulePost(channelId)
    } catch (e) {
      await Scheduler.logError("forcePost", e)
    }
  }

  async checkHealth() {
    const now = Date.now()
    const grace = 10 * 60_000
    let healthy = true

    if (
      this.#nextPostTime &&
      now > this.#nextPostTime + grace &&
      this.lastSuccessfulPostTime < this.#nextPostTime
    ) {
      Scheduler.logInfo("планировщик отстаёт")
      healthy = false
    } else if (
      !this.#nextPostTime &&
      now - this.lastSuccessfulPostTime > grace
    ) {
      Scheduler.logInfo("не постили более 10 мин")
      healthy = false
    }

    if (!healthy) {
      Scheduler.logInfo("авторестарт")
      clearTimeout(this.#timeoutId)
      if (this.#channelId) {
        await this.schedulePost(this.#channelId)
        Scheduler.logInfo("рестарт выполнен")
      } else {
        Scheduler.logInfo("нет channelId")
      }
    } else {
      Scheduler.logDebug(
        `здоровье OK; next=${new Date(this.#nextPostTime).toISOString()}, lastOK=${new Date(this.lastSuccessfulPostTime).toISOString()}`
      )
    }

    return healthy
  }

  cancelSchedule() {
    if (this.#timeoutId) {
      clearTimeout(this.#timeoutId)
      this.#timeoutId = null
      Scheduler.logInfo("таймер отменён")
    }
  }
}

module.exports = Scheduler
