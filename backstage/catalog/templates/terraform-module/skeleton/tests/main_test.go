package tests

import (
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

func TestBasicExample(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../examples/basic",
		Vars: map[string]interface{}{
			"name": "test-${{ values.name }}",
		},
		NoColor: true,
	}

	defer terraform.Destroy(t, opts)
	terraform.InitAndApply(t, opts)

	// Add assertions here. Example:
	// id := terraform.Output(t, opts, "id")
	// assert.NotEmpty(t, id)
	assert.NotNil(t, opts)
}
