# TrailDrop（トレイル・ドロップ）

岐阜県七宗町の国道41号線沿いにおける、間伐材（薪）やジビエの「移動ついで受取（スマート受取）」と「体験型ワークショップ」の予約・管理プラットフォーム。

## 構成

| ディレクトリ | 役割 | 担当 |
| --- | --- | --- |
| [`/frontend`](./frontend) | React (Vite) + Tailwind CSS によるフロントエンド | りく |
| [`/backend`](./backend) | Python (FastAPI) によるバックエンドAPI | しおん |
| [`/infra`](./infra) | Supabase (PostgreSQL) のスキーマ・デプロイ設定 | そうし |

## セットアップ

### frontend

```bash
cd frontend
npm install
npm run dev
```

### backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn main:app --reload
```

### infra / Supabase

1. Supabase プロジェクトを作成する。
2. `infra/schema.sql` を Supabase SQL Editor、または `supabase db push` で適用する。
3. 接続情報（`SUPABASE_URL`, `SUPABASE_KEY` 等）は `backend/.env` に設定する（`.gitignore` 対象）。

## 技術スタック

- フロントエンド: React (Vite) + Tailwind CSS
- バックエンド: Python (FastAPI)
- インフラ・DB: Supabase (PostgreSQL)
