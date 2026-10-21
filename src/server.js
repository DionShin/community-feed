const http = require('http')
const config = require('./config')
const db = require('./db')
const { createApp } = require('./app')
const hourlyStats = require('./services/hourlyStats')
const { startHourlyStatsJob } = require('./jobs/hourlyStatsJob')
const { startDataQualityJob } = require('./jobs/dataQualityJob')
const newPosts = require('./realtime/newPosts')
const { attachChat } = require('./realtime/chat')

async function main() {
  // 준비가 모두 끝난 뒤에 포트를 엶
  await db.connect(config.mongoUrl, config.dbName)
  await db.ensureIndexes()

  await hourlyStats.backfill()
  const stopStatsJob = startHourlyStatsJob()
  const stopQualityJob = startDataQualityJob()

  // Change Stream을 지원하지 않는 DB면 알림만 꺼지고 서버는 뜸
  await newPosts.start()

  // socket.io를 같은 포트에 붙이기 위해 http 서버를 직접 만듦
  const server = http.createServer(createApp())
  const io = attachChat(server)
  server.listen(config.port, () => {
    console.log(`서버 실행 중: http://localhost:${config.port}`)
  })

  const shutdown = async () => {
    stopStatsJob()
    stopQualityJob()
    // 열린 SSE 연결이 남아 있으면 서버 종료가 끝나지 않으므로 먼저 닫음
    await newPosts.stop()
    io.close(async () => {
      await db.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('서버 시작 실패:', err)
  process.exit(1)
})
