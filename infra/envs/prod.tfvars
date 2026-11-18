project_id                   = "soilflow-prod"
env                          = "prod"
domain                       = "soilflow.example.jp" # 【回答待ち Q-33】フジモト様のドメイン
db_tier                      = "db-g1-small"
min_instances_business_hours = 1
alert_emails                 = ["soilflow-ops@example.jp"]
# 本稼働後に true（7年は外せなくなる）
retention_locked = false
