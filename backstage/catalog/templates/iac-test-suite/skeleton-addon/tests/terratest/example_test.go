package test

import (
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// Replace TerraformDir with the module path you want to exercise.
// Terratest will `terraform init`, `terraform apply`, run the assertions,
// then `terraform destroy` even on failure.
func TestTerraformModule(t *testing.T) {
	t.Skip("Replace with your module's terratest. Remove t.Skip when ready.")

	tfOpts := &terraform.Options{
		TerraformDir: "../../${{ values.terraformDir }}",
		Vars: map[string]interface{}{
			// "name": "terratest-example",
		},
		NoColor: true,
	}

	defer terraform.Destroy(t, tfOpts)
	terraform.InitAndApply(t, tfOpts)

	// Example assertion: read an output and check it.
	// out := terraform.Output(t, tfOpts, "bucket_name")
	// assert.NotEmpty(t, out)
	assert.True(t, true)
}
