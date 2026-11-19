#!/usr/bin/env bash
# SoilFlow の GCP の環境を最初に作る（12 環境・インフラ設計書、16 7章）。何度流しても同じ結果になる。
#
#   gcloud auth login && gcloud auth application-default login && gh auth login   （最初に1回）
#   infra/bootstrap.sh stg  --project soilflow-stg  --billing 0123AB-4567CD-89EF01 --domain soilflow-stg.web.app --alert ops@example.jp --admin-email admin@example.jp
#   infra/bootstrap.sh prod --project soilflow-prod --billing 0123AB-4567CD-89EF01 --domain soilflow.example.jp  --alert ops@example.jp --admin-email admin@example.jp
#
# 任意：--org <組織ID> か --folder <フォルダID>（プロジェクトを置く場所）、--repo owner/name（既定 karkyon/soilflow）、--yes（確認を省く）
set -euo pipefail

ENV="${1:-}"; shift || true
PROJECT="" BILLING="" DOMAIN="" ALERT="" ADMIN_EMAIL="" ORG="" FOLDER="" REPO="karkyon/soilflow" YES=""
REGION="asia-northeast1"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --billing) BILLING="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --alert) ALERT="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --folder) FOLDER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "知らない引数：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
[[ "$ENV" == "stg" || "$ENV" == "prod" ]] || die "1つ目の引数は stg か prod です"
[[ -n "$PROJECT" && -n "$BILLING" && -n "$DOMAIN" && -n "$ALERT" && -n "$ADMIN_EMAIL" ]] || die "--project --billing --domain --alert --admin-email が必要です"
for c in gcloud terraform gh curl; do command -v "$c" >/dev/null || die "$c が見つかりません（インストールしてください）"; done
cd "$(dirname "$0")"

say "0. ログインの確認"
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
[[ -n "$ACCOUNT" ]] || die "gcloud auth login を先に実行してください"
gcloud auth application-default print-access-token >/dev/null 2>&1 || die "gcloud auth application-default login を先に実行してください（Terraform が使います）"
gh auth status >/dev/null 2>&1 || die "gh auth login を先に実行してください（GitHub の変数を入れます）"
echo "GCP：$ACCOUNT　GitHub：$REPO　環境：$ENV　プロジェクト：$PROJECT　ドメイン：$DOMAIN"
if [[ -z "$YES" ]]; then read -rp "この内容で作ります。よろしいですか？ [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]] || exit 1; fi

say "1. プロジェクトと課金"
if ! gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  parent=()
  [[ -n "$ORG" ]] && parent=(--organization "$ORG")
  [[ -n "$FOLDER" ]] && parent=(--folder "$FOLDER")
  gcloud projects create "$PROJECT" --name "SoilFlow $ENV" --labels "app=soilflow,env=$ENV" "${parent[@]}"
fi
gcloud billing projects link "$PROJECT" --billing-account "$BILLING" >/dev/null
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com iam.googleapis.com storage.googleapis.com firebase.googleapis.com --project "$PROJECT"

say "2. Terraform の状態ファイルのバケット"
STATE="${PROJECT}-tfstate"
if ! gcloud storage buckets describe "gs://$STATE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$STATE" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://$STATE" --versioning >/dev/null

say "3. terraform apply（先に Artifact Registry を作り、最初のコンテナを Cloud Build で作ってから全部を作る）"
export GOOGLE_CLOUD_QUOTA_PROJECT="$PROJECT"
terraform init -reconfigure -backend-config="bucket=$STATE" -input=false >/dev/null
TFVARS=(-var-file="envs/$ENV.tfvars" -var "project_id=$PROJECT" -var "domain=$DOMAIN" -var "alert_emails=[\"$ALERT\"]" -var "github_repository=$REPO")
TAG="$(git -C .. rev-parse HEAD)"
terraform apply -input=false "${TFVARS[@]}" -var "image_tag=$TAG" -target=google_project_service.apis -target=google_artifact_registry_repository.soilflow ${YES:+-auto-approve}
IMAGE="$REGION-docker.pkg.dev/$PROJECT/soilflow/api:$TAG"
if ! gcloud artifacts docker images describe "$IMAGE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud services enable cloudbuild.googleapis.com --project "$PROJECT"
  CB="$(mktemp)"; printf 'steps:\n- name: gcr.io/cloud-builders/docker\n  args: [build, -f, apps/api/Dockerfile, -t, "%s", .]\nimages: ["%s"]\noptions: { machineType: E2_HIGHCPU_8 }\n' "$IMAGE" "$IMAGE" > "$CB"
  (cd .. && gcloud builds submit --project "$PROJECT" --region "$REGION" --config "$CB" .)
fi
terraform apply -input=false "${TFVARS[@]}" -var "image_tag=$TAG" ${YES:+-auto-approve}
out() { terraform output -raw "$1"; }

say "4. シークレットの値（空のまま Enter でスキップ。あとで gcloud secrets versions add でも入れられます）"
for s in freee-client-id freee-client-secret sendgrid-api-key sendgrid-webhook-public-key; do
  latest="$(gcloud secrets versions access latest --secret "$s" --project "$PROJECT" 2>/dev/null || true)"
  [[ -n "$latest" && "$latest" != "UNSET" ]] && { echo "$s：入っています"; continue; }
  read -rsp "$s： " v; echo
  [[ -n "$v" ]] && printf '%s' "$v" | gcloud secrets versions add "$s" --project "$PROJECT" --data-file=- >/dev/null && echo "  入れました"
done

say "5. GitHub の Environment「$ENV」と変数"
gh api -X PUT "repos/$REPO/environments/$ENV" >/dev/null
gh variable set GCP_PROJECT --repo "$REPO" --env "$ENV" --body "$PROJECT"
gh variable set GCP_WIF_PROVIDER --repo "$REPO" --env "$ENV" --body "$(out gcp_workload_identity_provider)"
gh variable set GCP_DEPLOY_SA --repo "$REPO" --env "$ENV" --body "$(out gcp_deploy_service_account)"
PUBLIC_URL="https://$DOMAIN"; [[ "$DOMAIN" == *.web.app ]] || PUBLIC_URL="$(out hosting_default_url)"
gh variable set PUBLIC_URL --repo "$REPO" --env "$ENV" --body "$PUBLIC_URL"
gh variable set DEPLOY_ENABLED --repo "$REPO" --body true
[[ "$ENV" == "prod" ]] && echo "本番の Environment には GitHub の画面で「Required reviewers」（承認する人）を設定してください：https://github.com/$REPO/settings/environments"

say "6. 最初のデプロイ（コンテナ → DB の変更 → Cloud Run → Firebase Hosting）"
gh workflow run deploy.yml --repo "$REPO" --ref main -f "env=$ENV"
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')"
echo "https://github.com/$REPO/actions/runs/$RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || die "デプロイに失敗しました。上の URL でログを見てください"

say "7. 初期データと最初の管理者（DB の変更はデプロイで済み）"
ADMIN_PW="$(LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' </dev/urandom | head -c 16)"
gcloud run jobs execute soilflow-migrate --project "$PROJECT" --region "$REGION" --wait \
  --args=dist/prisma/seed.js --update-env-vars="SEED_ADMIN_LOGIN=admin,SEED_ADMIN_EMAIL=$ADMIN_EMAIL,SEED_ADMIN_PASSWORD=$ADMIN_PW" >/dev/null
echo "管理者：ログイン ID admin／仮のパスワード $ADMIN_PW（すでに管理者がいる環境では変わりません。初回ログインで変更）"

say "8. 確認"
curl -fsS "$(out api_url)/api/v1/healthz" && echo
if [[ "$DOMAIN" != *.web.app ]]; then
  echo "独自ドメイン $DOMAIN の DNS に、次のレコードを入れてください（証明書は自動で発行されます）："
  terraform output -json dns_records
fi
echo "画面：$PUBLIC_URL"
echo "このあと：16 移行・導入計画書（マスタの CSV・freee の連携・利用者の登録）"
