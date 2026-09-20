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

1. Supabase CLIをインストールし、`supabase login` を実行する。
2. `supabase start` でローカル環境を起動するか、Supabaseプロジェクトを作成する。
3. リモートを使う場合は `supabase link --project-ref <project-ref>` を実行する。
4. `supabase db push` で `supabase/migrations/` のマイグレーションを適用する。
5. SQL Editorを使う場合だけ、正本と同内容の補助ファイル `infra/schema.sql` を実行する。
6. `backend/.env.example` を `backend/.env` にコピーし、SupabaseのURL・publishable/anon key・許可するフロントエンドOrigin・スタッフAPIトークンを設定する。

`SUPABASE_KEY` にはフロントエンドへ公開しない値（`service_role` key）を設定しないでください。`.env` はコミットせず、Supabaseの秘密情報はバックエンドだけで使用します。

#### ローカル起動

```bash
supabase start
```

別ターミナルでフロントエンドとバックエンドを起動します。バックエンドは `backend/.env` の `SUPABASE_URL` と `SUPABASE_KEY` を使ってSupabase APIへ接続します。

## 技術スタック

- フロントエンド: React (Vite) + Tailwind CSS
- バックエンド: Python (FastAPI)
- インフラ・DB: Supabase (PostgreSQL)
