# TrailDrop（トレイル・ドロップ）

岐阜県七宗町を通る移動ルート上で、地域の商品を無人ロッカーから受け取るための予約サービスです。出発地・目的地から立ち寄れる受取地点と到着予定時刻を計算し、商品の予約、受取QRコードの発行、スタッフによる受取確認までを行います。

決済画面はデモ用で、実際の決済処理は行いません。

## 主な機能

- 出発地・目的地を指定したルート分析
- ルート上の受取地点と到着予定時刻の表示
- 地域商品の一覧・在庫表示
- 2時間単位の受取時間帯を指定した予約
- 予約完了時のQRコード発行
- スタッフ画面でのQR読取・受取完了処理
- 予約の確認・キャンセル
- デモモード

受取場所は無人ロッカーを前提とし、24時間受取可能です。

## システム構成

```text
利用者・スタッフのブラウザ
        │
        ▼
React + Vite + Tailwind CSS
Render Static Site
        │ REST API
        ▼
FastAPI + Uvicorn
Render Web Service
        ├── Supabase PostgreSQL
        └── Google Routes API
```

## 構成

| ディレクトリ | 役割 |
| --- | --- |
| [`/frontend`](./frontend) | React (Vite) + Tailwind CSS によるフロントエンド |
| [`/backend`](./backend) | Python (FastAPI) によるバックエンドAPI |
| [`/infra`](./infra) | Supabase (PostgreSQL) のスキーマ・デプロイ設定 |

| その他 | 役割 |
| --- | --- |
| [`/supabase/migrations`](./supabase/migrations) | Supabaseへ順番に適用するDBマイグレーション |
| [`.github/workflows`](./.github/workflows) | GitHub Actionsによるテスト・ビルド |
| [`render.yaml`](./render.yaml) | Renderバックエンドのデプロイ設定 |

## 技術スタック

### フロントエンド

- React 18 / JavaScript（JSX）
- React Router DOM 7
- Vite 6
- Tailwind CSS 3 / PostCSS / Autoprefixer
- `qrcode.react`（QRコード生成）
- BarcodeDetector API + `jsQR`（QRコード読取）
- MediaDevices `getUserMedia`（カメラ利用）
- `localStorage` / `sessionStorage`（画面状態・デモデータの保存）

### バックエンド・データベース

- Python 3.13
- FastAPI / Uvicorn
- Pydantic
- Supabase Python SDK
- Supabase（PostgreSQL）
- PostgreSQL RPC / SQL migration
- `httpx`（Google Routes APIとの通信）

### 外部サービス・運用

- Google Routes API（所要時間・距離・通過予定時刻の計算）
- Google Maps（受取地点を経由するナビゲーション）
- Render Static Site（フロントエンド）
- Render Web Service（バックエンド）
- GitHub Actions（CI）
- Vitest + jsdom / pytest（テスト）

## セットアップ

### frontend

```bash
cd frontend
npm ci
npm run dev
```

`frontend/.env.example` を `frontend/.env` にコピーし、必要な値を設定します。

| 環境変数 | 用途 |
| --- | --- |
| `VITE_API_BASE_URL` | FastAPIバックエンドのURL |
| `VITE_DEMO_MODE` | `true`でデモ用の商品・予約データを使用 |
| `VITE_ROUTE_ANALYSIS_CLIENT_KEY` | ルート分析APIへ送るクライアントキー |

`VITE_`で始まる値はブラウザへ組み込まれるため、秘密鍵を設定しないでください。

### backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate   # Windows PowerShell
# source venv/bin/activate  # macOS / Linux
pip install -r requirements.txt
uvicorn main:app --reload
```

`backend/.env.example` を `backend/.env` にコピーし、必要な値を設定します。

| 環境変数 | 用途 |
| --- | --- |
| `SUPABASE_URL` | SupabaseプロジェクトのURL |
| `SUPABASE_SERVICE_ROLE_KEY` | バックエンド専用のSupabaseキー |
| `ALLOWED_ORIGINS` | APIアクセスを許可するフロントエンドOrigin（カンマ区切り） |
| `STAFF_API_TOKEN` | スタッフ用APIの認証トークン |
| `GOOGLE_MAPS_API_KEY` | Google Routes APIのバックエンド用キー |
| `ROUTE_ANALYSIS_CLIENT_KEY` | フロントの同名クライアントキーと照合する値 |
| `PICKUP_SELECTION_MODE` | `fixed`または`route` |
| `PICKUP_MAX_DISTANCE_METERS` | `route`モードで許容するルートからの距離 |
| `TRUSTED_PROXY_IPS` | 信頼する直接接続プロキシのIP（通常は空） |

### infra / Supabase

1. Supabase CLIをインストールし、`supabase login` を実行する。
2. `supabase start` でローカル環境を起動するか、Supabaseプロジェクトを作成する。
3. リモートを使う場合は `supabase link --project-ref <project-ref>` を実行する。
4. `supabase db push` で `supabase/migrations/` のマイグレーションを適用する。
5. SQL Editorを使う場合だけ、正本と同内容の補助ファイル `infra/schema.sql` を実行する。
6. `backend/.env.example` を `backend/.env` にコピーし、SupabaseのURL・service_role key・許可するフロントエンドOrigin・スタッフAPIトークンを設定する。

`SUPABASE_SERVICE_ROLE_KEY` はバックエンド専用です。フロントエンド、`VITE_` で始まる環境変数、ブラウザに絶対に公開しないでください。`.env` はコミットせず、実値は `backend/.env` のみに設定します。

#### ローカル起動

```bash
supabase start
```

別ターミナルでフロントエンドとバックエンドを起動します。バックエンドは `backend/.env` の `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を使ってSupabase APIへ接続します。予約照会には、予約作成レスポンスに含まれる `access_token` を `X-Reservation-Token` ヘッダーで指定します。これはQR検証用の `qr_token` やスタッフ用の `X-Staff-Token` とは別のトークンです。

## テストとビルド

```bash
# フロントエンド
cd frontend
npm test
npm run build

# バックエンド
cd backend
pytest -q
```

Pull Request作成時と`main`へのpush時には、GitHub Actionsでフロントエンド・バックエンドのテスト、本番ビルド、差分の空白チェックを実行します。CIではSupabaseとGoogle Routes APIをモックし、実際の秘密鍵は使用しません。

## デプロイ

- フロントエンド: Render Static Site
  - Root Directory: `frontend`
  - Build Command: `npm ci && npm run build`
  - Publish Directory: `dist`
- バックエンド: Render Web Service
  - Root Directory: `backend`
  - Build Command: `pip install -r requirements.txt`
  - Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- データベース: Supabase

フロントエンド・バックエンドの環境変数はRender上で別々に設定します。DB変更を含むリリースでは、コードのデプロイとは別に`supabase db push`またはSupabase SQL Editorでマイグレーションを適用してください。

## 運用

本番運用では、期限切れ予約を解放して在庫を戻す処理を定期実行する必要があります。実行方法と頻度は、利用するホスティング・データベース環境に合わせて設定してください。
