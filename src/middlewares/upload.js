const crypto = require('crypto')
const path = require('path')
const multer = require('multer')
const config = require('../config')
const { HttpError } = require('../errors')

const MAX_FILES = 3
const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function createMulter() {
  // S3 설정이 없으면 텍스트 필드만 읽고 파일은 거절
  if (!config.s3) return multer({ limits: { files: 0 } }).none()

  const { S3Client } = require('@aws-sdk/client-s3')
  const multerS3 = require('multer-s3')
  const s3 = new S3Client({
    region: config.s3.region,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  })

  return multer({
    storage: multerS3({
      s3,
      bucket: config.s3.bucket,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      // 시각만 쓰면 같은 밀리초에 올라온 파일끼리 덮어쓸 수 있어 UUID를 붙임
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase()
        cb(null, `posts/${Date.now()}-${crypto.randomUUID()}${ext}`)
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_TYPES.has(file.mimetype)) return cb(null, true)
      cb(new HttpError(400, '이미지 파일(jpg, png, webp, gif)만 올릴 수 있습니다.'))
    },
  }).array('images', MAX_FILES)
}

const handler = createMulter()

// multer 에러를 사용자에게 보여줄 400 에러로 변환
function uploadPostImages(req, res, next) {
  handler(req, res, (err) => {
    if (!err) return next()
    if (err instanceof multer.MulterError) {
      if (!config.s3) return next(new HttpError(400, '이미지 업로드가 설정되지 않은 서버입니다.'))
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, '이미지는 한 장에 5MB 이하만 올릴 수 있습니다.'))
      return next(new HttpError(400, `이미지는 최대 ${MAX_FILES}장까지 올릴 수 있습니다.`))
    }
    next(err)
  })
}

module.exports = { uploadPostImages, uploadEnabled: Boolean(config.s3) }
