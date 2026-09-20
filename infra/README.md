# infra

TrailDropのインフラ関連ファイルです。

- `../supabase/migrations/` — Supabase CLIで適用するDB変更の正本です。
- `schema.sql` — SQL Editorで手動適用する場合の補助ファイルです。正本のマイグレーションと内容を同期します。
- `../supabase/config.toml` — Supabase CLIのローカル開発設定です。秘密情報は含めません。

## 適用手順

リポジトリのルートで以下を実行します。

```bash
supabase start
supabase db reset
```

既存のリモートプロジェクトへ適用する場合は、先に `supabase login` と `supabase link --project-ref <project-ref>` を実行し、その後 `supabase db push` を実行してください。

SQL Editorを使う場合は `schema.sql` を使用します。`SUPABASE_SERVICE_ROLE_KEY` や `STAFF_API_TOKEN` などの秘密情報はこのディレクトリやフロントエンドに置かず、バックエンドの `.env` だけに設定してください。
