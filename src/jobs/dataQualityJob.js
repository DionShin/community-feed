const dataQuality = require('../services/dataQuality')

const INTERVAL_MS = 10 * 60 * 1000

// 10분마다 품질 검사 결과를 저장하고, 기준을 넘으면 경고 로그
function startDataQualityJob({ intervalMs = INTERVAL_MS } = {}) {
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      const report = await dataQuality.runChecks()
      await dataQuality.saveReport(report)
      for (const c of report.checks) {
        if (c.status === 'warn' || c.status === 'fail') {
          console.warn(`[데이터 품질 ${c.status}] ${c.title}: ${c.value} (기준 ${c.threshold})`)
        }
      }
    } catch (err) {
      console.error('데이터 품질 검사 실패:', err.message)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

module.exports = { startDataQualityJob }
