const hourlyStats = require('../services/hourlyStats')

const INTERVAL_MS = 60 * 1000

// 서버가 여러 대면 각 서버가 같은 계산을 반복함(덮어쓰기라 결과는 같지만 낭비). 그때는 별도 작업 프로세스나 잠금 필요
function startHourlyStatsJob({ intervalMs = INTERVAL_MS } = {}) {
  let running = false

  async function tick() {
    // 이전 실행이 안 끝났으면 건너뜀
    if (running) return
    running = true
    const startedAt = Date.now()
    try {
      await hourlyStats.rebuildRecent({ now: new Date() })
      const elapsed = Date.now() - startedAt
      if (elapsed > intervalMs / 2) console.warn(`시간별 통계 갱신이 느립니다: ${elapsed}ms`)
    } catch (err) {
      // 다음 실행에서 다시 계산하므로 서버를 멈추지 않음
      console.error('시간별 통계 갱신 실패:', err.message)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

module.exports = { startHourlyStatsJob }
