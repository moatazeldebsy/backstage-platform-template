# Aurora Global Database — ${{ values.clusterName }}
# Requested by: ${{ values.owner }}
# Apply: terraform -chdir=terraform/global apply -var-file=tfvars/${{ values.clusterName }}.tfvars

rds_db_name        = "${{ values.dbName }}"
rds_username       = "${{ values.dbName }}_admin"
rds_instance_class = "${{ values.instanceClass }}"
