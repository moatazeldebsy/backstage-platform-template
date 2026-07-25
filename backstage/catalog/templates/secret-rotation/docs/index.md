# Secret with Rotation Reminder

Provision a secret in AWS Secrets Manager, wire it into your service via External Secrets Operator,
and schedule a recurring GitHub issue reminder to rotate it.

## How to use

1. Open Backstage → **Create**
2. Find **Secret with Rotation Reminder** and click **Choose**
3. Fill in the required parameters, choose a rotation reminder interval, and click **Create**

## Source

Template definition: [`template.yaml`](../template.yaml)
