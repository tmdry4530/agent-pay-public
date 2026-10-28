/**
 * PayPal Payouts v1 fixtures, copied from official PayPal developer docs.
 *
 * Every object below is copied as written in the source named above it.
 * Nothing here is captured from a live PayPal call. Where the docs do not give
 * a shape (for example the duplicate `sender_batch_id` error body), there is no
 * fixture; see the "not documented" list in the error-fixtures report.
 *
 * The docs do not state which HTTP status goes with each named error. Tests
 * pick a status from the documented response codes for the endpoint
 * (POST /v1/payments/payouts: 201, 400, 403, 500, default).
 */

// Source: https://developer.paypal.com/api/payments.payouts-batch/v1/definitions/transaction_enum
// Section: "Transaction status", Allowed values (also `transaction_enum` in
// https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payouts_batch_v1.json)
export const TRANSACTION_STATUS_VALUES = [
  'SUCCESS',
  'FAILED',
  'PENDING',
  'UNCLAIMED',
  'RETURNED',
  'ONHOLD',
  'BLOCKED',
  'REFUNDED',
  'REVERSED',
] as const;

// Source: https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payouts_batch_v1.json
// Section: components.schemas.batch_enum ("Batch status").
// Same list in https://developer.paypal.com/api/payouts section "2. Track status"
// ("Possible values: SUCCESS, PENDING, PROCESSING, DENIED, CANCELED").
export const BATCH_STATUS_VALUES = ['DENIED', 'PENDING', 'PROCESSING', 'SUCCESS', 'CANCELED'] as const;

// Source: https://developer.paypal.com/api/payouts
// Section: "1. Create payout batch", sample 201 response.
// Note: the docs sample has a trailing comma after `sender_batch_header`; kept as written.
export const CREATE_PAYOUT_201 = {
  "batch_header": {
    "payout_batch_id": "3TRXJ4Z8XJ8QY",
    "batch_status": "PENDING",
    "sender_batch_header": {
      "sender_batch_id": "Batch-123",
      "email_subject": "You have a payout!"
    },
  },
  "links": [
    {
      "href": "https://api-m.sandbox.paypal.com/v1/payments/payouts/3TRXJ4Z8XJ8QY",
      "rel": "self",
      "method": "GET",
      "encType": "application/json"
    }
  ]
};

// Source: https://developer.paypal.com/api/payouts
// Section: "2. Track status" > "Poll for updates", sample 200 response for
// GET /v1/payments/payouts/MJ77GF8MQ2TF6.
export const SHOW_PAYOUT_BATCH_200 = {
  "total_items": 3,
  "total_pages": 1,
  "batch_header": {
    "payout_batch_id": "MJ77GF8MQ2TF6",
    "batch_status": "SUCCESS",
    "time_created": "2023-04-10T20:16:44Z",
    "time_completed": "2023-04-10T20:16:45Z",
    "sender_batch_header": {
      "sender_batch_id": "Payouts_1681157804",
      "email_subject": "You have a payout!",
      "email_message": "You have received a payout! Thanks for using our service!"
    },
    "funding_source": "BALANCE",
    "amount": {
      "currency": "USD",
      "value": "60.00"
    },
    "fees": {
      "currency": "USD",
      "value": "0.50"
    }
  },
  "items": [
    {
      "payout_item_id": "CX64X3KPCVYLC",
      "transaction_id": "4XH44110EC095525K",
      "activity_id": "0KJ317812H109105P",
      "transaction_status": "UNCLAIMED",
      "payout_item_fee": {
        "currency": "USD",
        "value": "0.25"
      },
      "payout_batch_id": "MJ77GF8MQ2TF6",
      "payout_item": {
        "recipient_type": "EMAIL",
        "amount": {
          "currency": "USD",
          "value": "10.00"
        },
        "note": "Thanks for your patronage!",
        "receiver": "recipient@example.com",
        "sender_item_id": "201403140001",
        "recipient_wallet": "PAYPAL"
      },
      "time_processed": "2023-04-10T20:16:45Z",
      "links": [
        {
          "href": "https://api.sandbox.paypal.com/v1/payments/payouts-item/CX64X3KPCVYLC",
          "rel": "item",
          "method": "GET"
        }
      ]
    },
    {
      "payout_item_id": "S697W7QJMAEX4",
      "transaction_id": "0FY48488BY887313U",
      "transaction_status": "UNCLAIMED",
      "payout_item_fee": {
        "currency": "USD",
        "value": "0.25"
      },
      "payout_item": {
        "recipient_type": "PHONE",
        "amount": {
          "currency": "USD",
          "value": "20.00"
        },
        "note": "Thanks for your support!",
        "receiver": "15562941698",
        "sender_item_id": "201403140002",
        "recipient_wallet": "PAYPAL"
      },
      "time_processed": "2023-04-10T20:16:45Z"
    },
    {
      "payout_item_id": "J64P4FHTAY7UN",
      "transaction_status": "FAILED",
      "payout_item_fee": {
        "currency": "USD",
        "value": "0.00"
      },
      "payout_item": {
        "recipient_type": "PAYPAL_ID",
        "amount": {
          "currency": "USD",
          "value": "30.00"
        },
        "note": "Thanks for your patronage!",
        "receiver": "invalid@example.com",
        "sender_item_id": "201403140003",
        "recipient_wallet": "PAYPAL"
      },
      "errors": {
        "name": "RECEIVER_ACCOUNT_INVALID",
        "message": "Receiver's account is invalid."
      }
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v1/payments/payouts/MJ77GF8MQ2TF6?page_size=1000&page=1",
      "rel": "self",
      "method": "GET"
    }
  ]
};

// Source: https://developer.paypal.com/api/payouts
// Section: "4. Test" > "Test API calls: use test values and simulate responses"
// (simulated error for items[0]/note = ERRPYO002). HTTP status is not stated.
export const SENDER_EMAIL_UNCONFIRMED_ERROR = {
  "name": "SENDER_EMAIL_UNCONFIRMED",
  "message": "Authorization error occurred",
  "debug_id": "ca787bdf80d7a",
  "information_link": "https://developer.paypal.com/docs/api/payments.payouts-batch/v1/#errors"
};

// Source: https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payouts_batch_v1.json
// Section: components.schemas.error_500.example. The example's link points at
// the Orders v2 docs; kept as written.
export const INTERNAL_SERVER_ERROR_500 = {
  "name": "INTERNAL_SERVER_ERROR",
  "message": "An internal server error occurred.",
  "debug_id": "90957fca61718",
  "links": [
    {
      "href": "https://developer.paypal.com/api/orders/v2/#error-INTERNAL_SERVER_ERROR",
      "rel": "information_link"
    }
  ]
};

// Source: https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payouts_batch_v1.json
// Section: components.schemas.error_503.example. Link points at Orders v2 docs; kept as written.
export const SERVICE_UNAVAILABLE_503 = {
  "name": "SERVICE_UNAVAILABLE",
  "message": "Service Unavailable.",
  "debug_id": "90957fca61718",
  "information_link": "https://developer.paypal.com/docs/api/orders/v2/#error-SERVICE_UNAVAILABLE"
};

// Source: https://developer.paypal.com/api/rest/responses/
// Section: "Authorization errors" > "Example" > "Response" (HTTP 401 from
// POST /v1/oauth2/token with an invalid client ID).
export const OAUTH_INVALID_CLIENT_401 = {
  "error": "invalid_client",
  "error_description": "Client Authentication failed"
};

// Source: https://developer.paypal.com/api/payments.payouts-batch/v1/payouts-post
// Section: "x-errors" list embedded in the page's API definition (the Payouts
// error names and messages). Order and text kept as written. The docs do not
// give an HTTP status or a full response body (debug_id, details) for these
// names; they also appear as item-level `errors` (see SHOW_PAYOUT_BATCH_200).
export const PAYOUTS_ERROR_MESSAGES: ReadonlyArray<{ readonly name: string; readonly message: string }> = [
  { name: "ACCOUNT_RESTRICTED", message: "Access to your account has been restricted. Contact your account manager or our customer service team for assistance." },
  { name: "ACCOUNT_UNCONFIRMED_EMAIL", message: "You need to be a verified PayPal account holder to send payouts. You can verify your account by confirming your email and your bank account or credit card. Contact your account manager or our customer service team for assistance." },
  { name: "AUTHORIZATION_ERROR", message: "Your account is not authorized to use payouts. Contact your account manager or our customer service team for assistance." },
  { name: "BATCH_NOT_COMPLETED", message: "This payout batch is still being processed. Please try again later." },
  { name: "CLOSED_MARKET", message: "This account is not allowed to receive payouts from other countries. Try re-sending this payout to another account." },
  { name: "CURRENCY_COMPLIANCE", message: "Due to currency compliance regulations, you are not allowed to make this transaction." },
  { name: "CURRENCY_NOT_SUPPORTED_FOR_RECEIVER", message: "This currency cannot be accepted for this recipient\u2019s account. You can re-send this payout with a different currency." },
  { name: "DUPLICATE_ITEM", message: "This transaction is duplicated in this batch. Please check the Ref_ID / Sender_Item_ID." },
  { name: "GAMER_FAILED_COUNTRY_OF_RESIDENCE_CHECK", message: "The recipient lives in a country that is not allowed to accept this payout." },
  { name: "GAMER_FAILED_FUNDING_SOURCE_CHECK", message: "The funding source that was selected for this payout is not allowed. Try again by using your PayPal balance instead." },
  { name: "GAMING_INVALID_PAYMENT_FLOW", message: "This payment flow is not allowed for gaming merchant accounts." },
  { name: "INSUFFICIENT_FUNDS", message: "You have insufficient funds in your PayPal balance. You'll need to add funds to your account to complete the payout." },
  { name: "INTERNAL_ERROR", message: "An error occurred while processing this payout request. Please re-submit this payout as a new batch or file." },
  { name: "ITEM_ALREADY_CANCELLED", message: "This payout request has already been cancelled." },
  { name: "ITEM_CANCELLATION_FAILED", message: "An error occurred while processing this payout request. Try again in a few minutes." },
  { name: "ITEM_INCORRECT_STATUS", message: "You can only cancel items that are unclaimed." },
  { name: "VALIDATION_ERROR", message: "JSON request is malformed. Check your request format and try again." },
  { name: "NEGATIVE_BALANCE", message: "You have insufficient funds in your PayPal balance. You'll need to add funds to your account to complete the payout." },
  { name: "NON_HOLDING_CURRENCY", message: "Your account does not have a PayPal balance in this currency. Try again with a currency that has funds in your PayPal account, or change your account settings to this currency." },
  { name: "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE", message: "This payout is pending because the recipient has set their account preferences to review credits in this currency. The recipient has been notified. Check back later for the status of this payout." },
  { name: "POS_LIMIT_EXCEEDED", message: "You have exceeded the POS cumulative spending limit. Contact your account manager or our customer service team for assistance." },
  { name: "RATE_LIMIT_VALIDATION_FAILURES", message: "Your request has been blocked due to multiple failed attempts. Please try again later." },
  { name: "RECEIVER_ACCOUNT_LOCKED", message: "We were not able to send a payout because the recipient\u2019s account is inactive or restricted. Funds have been returned to your account." },
  { name: "RECEIVER_COUNTRY_NOT_ALLOWED", message: "We can\u2019t send this payout because the recipient lives in a country where payouts are not allowed." },
  { name: "RECEIVER_STATE_RESTRICTED", message: "We can\u2019t send this payout because the recipient lives in a state where payouts are not allowed." },
  { name: "RECEIVER_UNCONFIRMED", message: "The recipient\u2019s email or phone number is unconfirmed. Any payments made to this account will be marked as Unclaimed until the recipient confirms their account information. Funds will be returned to your account if they are not claimed within 30 days." },
  { name: "RECEIVER_UNREGISTERED", message: "The recipient for this payout does not have an account. A link to sign up for an account was sent to the recipient. However, if the recipient does not claim this payout within 30 days, the funds will be returned to your account." },
  { name: "RECEIVER_ACCOUNT_LIMITATION", message: "The recipient's account is currently under limitation. Any payments made to this account will be on hold until the issue is resolved. Funds will be returned to your account if the limitation is not resolved within 30 days of the sent payout." },
  { name: "RECEIVER_YOUTH_ACCOUNT", message: "We were not able to send a payout because the recipient has a youth account. Please check with the recipient for an alternate account to receive the payout." },
  { name: "RECEIVING_LIMIT_EXCEEDED", message: "The recipient cannot accept this payout, because it exceeds the amount they can receive at this time. Please resubmit your payout request for a different amount." },
  { name: "REFUSED_ACCESS_DENIED", message: "Your account is not allowed to send money. Check with your primary account holder to get permission to send money." },
  { name: "RECEIVER_REFUSED", message: "The recipient has refused this payout in this currency. Try resending in a different currency." },
  { name: "REGULATORY_BLOCKED", message: "This transaction is blocked due to regulatory compliance restrictions." },
  { name: "REGULATORY_PENDING", message: "This transaction is pending, while it is reviewed for compliance with government regulations." },
  { name: "REQUIRED_SCOPE_MISSING", message: "The access token doesn't have the required scope. You'll need to use the access token with the correct scope to send a payout." },
  { name: "RISK_DECLINE", message: "This transaction was declined due to risk concerns." },
  { name: "SELF_PAY_NOT_ALLOWED", message: "You can\u2019t send a payout to yourself. Try sending it to a different account." },
  { name: "SENDER_ACCOUNT_LOCKED", message: "You can\u2019t send a payout now, because your account is locked or inactive. Contact your account manager or our customer service team for assistance." },
  { name: "SENDER_ACCOUNT_UNVERIFIED", message: "To send a payout, you need to have a verified PayPal account. You can verify your account by confirming your bank account or credit card. Contact your account manager or our customer service team for assistance." },
  { name: "SENDER_STATE_RESTRICTED", message: "Your address is in a state where payouts are not allowed. Contact your account manager or our customer service team for assistance." },
  { name: "SPENDING_LIMIT_EXCEEDED", message: "You\u2019ve exceeded your spending limit. Contact your account manager or our customer service team for assistance." },
  { name: "TRANSACTION_DECLINED_BY_TRAVEL_RULE", message: "Your payout request does not comply with travel rule regulations. To send this payout, you\u2019ll need to update and verify your account information. Contact your account manager or our customer service team for assistance." },
  { name: "TRANSACTION_LIMIT_EXCEEDED", message: "This payout request has exceeded the limit for this type of transaction. The funds have been returned to your account." },
  { name: "UNDEFINED", message: "An error occurred while processing this payout request. Try again in a few minutes, or try resending as part of a new request or file." },
  { name: "UNVERIFIED_RECIPIENT_NOT_SUPPORTED", message: "This payout request was not completed because the recipient has not verified their account. Your account is only allowed to send payout to verified accounts." },
  { name: "USER_BUSINESS_ERROR", message: "An error occurred while processing this payout request. For batch processing, try again with a different `sender_batch_ID`. For single payout items, try again with email or payer ID as recipient type." },
  { name: "USER_COUNTRY_NOT_ALLOWED", message: "Your address is in a country where payouts are not allowed. Contact your account manager or our customer service team for assistance." },
  { name: "USER_FUNDING_SOURCE_INELIGIBLE", message: "The funding source for this payout is not allowed. Try again by using your PayPal balance instead." },
  { name: "ZERO_AMOUNT", message: "Please provide a valid payment amount." },
  { name: "APPROVER_DENIED", message: "Payout request rejected by the approver. Please check with your approver." },
  { name: "INVALID_EMAIL", message: "Email Address doesn\u2019t exist. Try again with the correct Email Id." },
  { name: "PHONE_NUMBER_INVALID", message: "We were unable to deliver the Payout SMS to this recipient. This might be due to an invaild or incorrect phone number. Any amount deducted from this account will be returned shortly." },
  { name: "PHONE_NUMBER_SMS_OPTOUT", message: "The receiver of this payout has opted out of PayPal SMS services. We were unable to deliver the payout SMS for the receiver to claim. Any amount deducted from this account will be returned shortly." },
  { name: "RECEIVER_ACCOUNT_NOT_ELIGIBLE", message: "The receiver account is not eligible to receive the payout sent." },
  { name: "RECEIVER_ACCOUNT_UNVERIFIED", message: "Your Payout request does not comply with the receiver country regulations. To send this payout, the receiver needs to update and verify their account information." },
];
