# MinIO 预签名上传 API（MVP）

## 1. 安装

```bash
cd backend
npm install
cp .env.example .env
```

## 2. 启动

```bash
npm run dev
```

接口默认地址：`http://127.0.0.1:3000`

## 3. 健康检查

```bash
curl http://127.0.0.1:3000/healthz
```

## 4. 获取预签名 URL

```bash
curl -X POST "http://127.0.0.1:3000/api/upload/presign" \
  -H "Content-Type: application/json" \
  -H "x-user-id: u1001" \
  -d "{\"fileName\":\"demo.jpg\",\"contentType\":\"image/jpeg\",\"fileSize\":102400}"
```

返回 `uploadUrl` 后，客户端使用 `PUT` 上传二进制即可。

当前允许的文件类型：

- `image/jpeg`
- `image/png`
- `image/webp`
- `video/mp4`
- `video/quicktime`

## 5. Docker Compose（后端 + Nginx）

在项目根目录执行：

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入 MinIO 连接信息
docker compose up -d --build
```

默认对外端口为 `80`，可通过以下地址访问：

- `http://<服务器IP>/healthz`
- `http://<服务器IP>/api/upload/presign`

## 6. 预签名与分片上传共存建议

可以和当前预签名单文件上传共存，建议按文件大小分流：

- 小文件（例如 `< 20MB`）走当前 `POST /api/upload/presign`
- 大文件（例如 `>= 20MB`）走分片上传流程

推荐分片接口：

- `POST /api/upload/multipart/init`
- `POST /api/upload/multipart/sign-part`
- `POST /api/upload/multipart/complete`
- `POST /api/upload/multipart/abort`（可选）

### 分片上传接口示例

1) 初始化分片上传

```bash
curl -X POST "http://127.0.0.1:3000/api/upload/multipart/init" \
  -H "Content-Type: application/json" \
  -H "x-user-id: u1001" \
  -d "{\"fileName\":\"demo.mov\",\"contentType\":\"video/quicktime\",\"fileSize\":52428800}"
```

2) 为指定分片生成上传 URL

```bash
curl -X POST "http://127.0.0.1:3000/api/upload/multipart/sign-part" \
  -H "Content-Type: application/json" \
  -H "x-user-id: u1001" \
  -d "{\"objectKey\":\"u1001/2026/04/17/xxx_demo.mov\",\"uploadId\":\"<uploadId>\",\"partNumber\":1}"
```

3) 客户端逐片 PUT 后，回传 partNumber + etag 完成合并

```bash
curl -X POST "http://127.0.0.1:3000/api/upload/multipart/complete" \
  -H "Content-Type: application/json" \
  -H "x-user-id: u1001" \
  -d "{\"objectKey\":\"u1001/2026/04/17/xxx_demo.mov\",\"uploadId\":\"<uploadId>\",\"parts\":[{\"partNumber\":1,\"etag\":\"<etag1>\"},{\"partNumber\":2,\"etag\":\"<etag2>\"}]}"
```

4) 取消未完成分片上传（可选）

```bash
curl -X POST "http://127.0.0.1:3000/api/upload/multipart/abort" \
  -H "Content-Type: application/json" \
  -H "x-user-id: u1001" \
  -d "{\"objectKey\":\"u1001/2026/04/17/xxx_demo.mov\",\"uploadId\":\"<uploadId>\"}"
```
