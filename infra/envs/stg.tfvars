project_id                   = "soilflow-stg"
env                          = "stg"
domain                       = "soilflow-stg.web.app"
db_tier                      = "db-f1-micro"
min_instances_business_hours = 0
alert_emails                 = ["soilflow-ops@example.jp"]
# 検証の環境のメールは試験用のアドレスへ（09 5章）
mail_redirect_to = "soilflow-test@example.jp"
