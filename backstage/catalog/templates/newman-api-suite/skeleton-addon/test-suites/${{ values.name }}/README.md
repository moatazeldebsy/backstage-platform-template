# ${{ values.name }}

${{ values.description }}

Newman API test suite targeting `${{ values.targetService }}`.

## Quick start

```bash
npm install
npm test                            # run collection
BASE_URL=http://... npm test        # override target URL
npm run report                      # open HTML report
```

## Structure

```
collections/
  ${{ values.name }}.postman_collection.json
environments/
  dev.postman_environment.json
reports/                           # generated, git-ignored
```
