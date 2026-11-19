# SoilFlow の GCP（12 環境・インフラ・ネットワーク設計書）。環境ごとに別のプロジェクト（soilflow-stg・soilflow-prod）
#   terraform init -backend-config="bucket=soilflow-<env>-tfstate"
#   terraform apply -var-file=envs/<env>.tfvars
terraform {
  required_version = ">= 1.9"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 6.10" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 6.10" }
    random      = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "gcs" { prefix = "terraform" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

locals {
  env      = var.env
  api_name = "soilflow-api"
  # Cloud Run の決まった URL（自分の URL を環境変数に入れるため。Scheduler の OIDC の送り先）
  api_url = "https://${local.api_name}-${data.google_project.this.number}.${var.region}.run.app"
  image   = "${var.region}-docker.pkg.dev/${var.project_id}/soilflow/api:${var.image_tag}"
  labels  = { app = "soilflow", env = var.env }
}
