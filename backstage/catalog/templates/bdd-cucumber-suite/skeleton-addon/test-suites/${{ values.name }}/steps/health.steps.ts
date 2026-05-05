import { Given, When, Then } from '@cucumber/cucumber';
import axios from 'axios';
import assert from 'assert';

let baseUrl: string;
let response: { status: number };

Given('the service is running at {string}', (url: string) => {
  baseUrl = process.env.BASE_URL ?? url;
});

When('I request {string}', async (path: string) => {
  response = await axios.get(`${baseUrl}${path}`, { validateStatus: () => true });
});

Then('the response status should be {int}', (expected: number) => {
  assert.strictEqual(response.status, expected);
});
