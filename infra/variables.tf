variable "project_id" { type = string }
variable "env" {
  type = string
  validation {
    condition     = contains(["stg", "prod"], var.env)
    error_message = "env は stg か prod"
  }
}
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "domain" {
  description = "画面の独自ドメイン（Firebase Hosting）。例 soilflow.example.jp（Q-33）"
  type        = string
}
variable "image_tag" {
  description = "Cloud Run に載せるイメージのタグ（GitHub Actions がコミットの SHA を渡す）"
  type        = string
  default     = "latest"
}
variable "db_tier" {
  description = "Cloud SQL のマシン（12 6章。安くするなら db-f1-micro）"
  type        = string
  default     = "db-g1-small"
}
variable "min_instances_business_hours" {
  description = "営業時間（7:00〜18:00）の Cloud Run の最小台数（NFR-01）"
  type        = number
  default     = 1
}
variable "alert_emails" {
  description = "アラートの送り先（保守担当）"
  type        = list(string)
}
variable "github_repository" {
  description = "デプロイを許す GitHub のリポジトリ（owner/name）"
  type        = string
  default     = "karkyon/soilflow"
}
variable "mail_redirect_to" {
  description = "検証の環境ではメールの宛先をこのアドレスに置き換える（09 5章）。本番は空"
  type        = string
  default     = ""
}
variable "retention_locked" {
  description = "files・archive バケットの保持ポリシーをロックする（本稼働後に true。ロックすると7年は外せない）"
  type        = bool
  default     = false
}
