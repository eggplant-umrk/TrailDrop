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
6. `backend/.env.example` を `backend/.env` にコピーし、SupabaseのURL・service_role key・許可するフロントエンドOrigin・スタッフAPIトークンを設定する。

`SUPABASE_SERVICE_ROLE_KEY` はバックエンド専用です。フロントエンド、`VITE_` で始まる環境変数、ブラウザに絶対に公開しないでください。`.env` はコミットせず、実値は `backend/.env` のみに設定します。

#### ローカル起動

```bash
supabase start
```

別ターミナルでフロントエンドとバックエンドを起動します。バックエンドは `backend/.env` の `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を使ってSupabase APIへ接続します。予約照会には、予約作成レスポンスに含まれる `access_token` を `X-Reservation-Token` ヘッダーで指定します。これはQR検証用の `qr_token` やスタッフ用の `X-Staff-Token` とは別のトークンです。

## 運用

### 期限切れ予約の自動キャンセル

受取時間帯（`pickup_window_end`）を過ぎても受け取られない `pending` 予約は、そのままだと在庫を確保し続けます。これを解放するため、RPC `expire_stale_pending_reservations()` を用意しています。

- **対象**: `status = 'pending'` かつ `pickup_window_end + 30分 < 現在時刻` の予約（猶予30分。渋滞などで少し遅れた受取に対応するため）。
- **処理**: 対象予約を `cancelled` にし（決済済みなら `payment_status` も `cancelled`）、在庫を1つ戻します。予約1件ごとに状態変更と在庫返却は同じトランザクションで行われ、顧客キャンセル・QR受取確認と同時に実行されても二重に在庫が戻ることはありません。
- **1回の上限**: 最大500件。残りがあれば次回の実行で処理されます。
- **ステータス**: 期限切れも顧客によるキャンセルも同じ `cancelled` です（MVPでは区別しません）。

**本番では、cron等でこの処理を定期実行する必要があります。** このリポジトリには定期実行の仕組み自体は含まれていません。推奨頻度は **10分ごと** です（何度実行しても安全です）。

APIで実行する例（`X-Staff-Token` 必須。認証に失敗するとレート制限の対象になります）:

```bash
curl -X POST "https://<backend-host>/staff/reservations/expire-stale" \
  -H "X-Staff-Token: $STAFF_API_TOKEN"
# => {"expired_count": 2, "expired_ids": ["...", "..."]}
```

SQLで実行する例（Supabase SQL Editor、または pg_cron を有効にしたプロジェクト）:

```sql
select id, item_id, pickup_window_end from public.expire_stale_pending_reservations();

-- pg_cronを使う場合の例（10分ごと）
select cron.schedule(
  'expire-stale-pending-reservations',
  '*/10 * * * *',
  $$select public.expire_stale_pending_reservations()$$
);
```

**既知の制約**: `pickup_window_end` が無い予約（ルート分析を経由せず商品一覧から直接行った予約、受取時間帯の機能より前に作られた予約）は、この自動期限切れの対象外です。これらの予約は、顧客によるキャンセルまたはスタッフの対応がない限り在庫を確保し続けます。

## 技術スタック

- フロントエンド: React (Vite) + Tailwind CSS
- バックエンド: Python (FastAPI)
- インフラ・DB: Supabase (PostgreSQL)
