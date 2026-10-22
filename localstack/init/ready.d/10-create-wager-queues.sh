#!/usr/bin/env bash
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

attributes_file="$(mktemp)"
trap 'rm -f "$attributes_file" "${queue_attributes_file:-}"' EXIT
python3 - "$dlq_arn" "$attributes_file" <<'PY'
import json
import sys

dlq_arn, output_path = sys.argv[1:]
attributes = {
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "RedrivePolicy": json.dumps(
        {"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "5"}
    ),
}
with open(output_path, "w", encoding="utf-8") as output:
    json.dump(attributes, output)
PY

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "file://${attributes_file}"

queue_attributes_file="$(mktemp)"
python3 - "$dlq_arn" "$queue_attributes_file" <<'PY'
import json
import sys

dlq_arn, output_path = sys.argv[1:]
attributes = {
    "VisibilityTimeout": "60",
    "RedrivePolicy": json.dumps(
        {"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "5"}
    ),
}
with open(output_path, "w", encoding="utf-8") as output:
    json.dump(attributes, output)
PY
awslocal sqs set-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --attributes "file://${queue_attributes_file}"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
