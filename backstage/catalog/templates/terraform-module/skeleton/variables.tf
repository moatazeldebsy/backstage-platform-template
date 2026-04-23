variable "create" {
  description = "Controls whether resources should be created"
  type        = bool
  default     = true
}

variable "name" {
  description = "Name prefix for all resources created by this module"
  type        = string
}

variable "tags" {
  description = "A map of tags to add to all resources"
  type        = map(string)
  default     = {}
}
