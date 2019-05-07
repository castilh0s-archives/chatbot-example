const dialogflow = require("dialogflow");
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const request = require("request");
const uuid = require("uuid");
const pg = require("pg");
const config = require("./config");
const app = express();

pg.defaults.ssl = true;

const userService = require("./services/user");
const colorsService = require("./services/colors");
const weatherService = require("./services/weather");
const jobApplicationService = require("./services/job-application");
const dialogflowService = require("./services/dialogflow");
const fbService = require("./services/facebook");

if (!config.FB_PAGE_TOKEN) {
  throw new Error("missing FB_PAGE_TOKEN");
}
if (!config.FB_VERIFY_TOKEN) {
  throw new Error("missing FB_VERIFY_TOKEN");
}
if (!config.GOOGLE_PROJECT_ID) {
  throw new Error("missing GOOGLE_PROJECT_ID");
}
if (!config.DF_LANGUAGE_CODE) {
  throw new Error("missing DF_LANGUAGE_CODE");
}
if (!config.GOOGLE_CLIENT_EMAIL) {
  throw new Error("missing GOOGLE_CLIENT_EMAIL");
}
if (!config.GOOGLE_PRIVATE_KEY) {
  throw new Error("missing GOOGLE_PRIVATE_KEY");
}
if (!config.FB_APP_SECRET) {
  throw new Error("missing FB_APP_SECRET");
}
if (!config.SERVER_URL) {
  throw new Error("missing SERVER_URL");
}
if (!config.SENDGRID_API_KEY) {
  throw new Error("missing SENDGRID_API_KEY");
}
if (!config.EMAIL_FROM) {
  throw new Error("missing EMAIL_FROM");
}
if (!config.EMAIL_TO) {
  throw new Error("missing EMAIL_TO");
}
if (!config.WEATHER_API_KEY) {
  throw new Error("missing WEATHER_API_KEY");
}
if (!config.PG_CONFIG) {
  throw new Error("missing PG_CONFIG");
}

app.set("port", process.env.PORT || 5000);

//verify request came from facebook
app.use(
  bodyParser.json({
    verify: fbService.verifyRequestSignature
  })
);

//serve static files in the public directory
app.use(express.static("public"));

// Process application/x-www-form-urlencoded
app.use(
  bodyParser.urlencoded({
    extended: false
  })
);

// Process application/json
app.use(bodyParser.json());

const credentials = {
  client_email: config.GOOGLE_CLIENT_EMAIL,
  private_key: config.GOOGLE_PRIVATE_KEY
};

const sessionClient = new dialogflow.SessionsClient({
  projectId: config.GOOGLE_PROJECT_ID,
  credentials
});

const sessionIds = new Map();
const usersMap = new Map();

// Index route
app.get("/", function(req, res) {
  res.send("Hello world, I am a chatbot");
});

// for Facebook verification
app.get("/webhook/", function(req, res) {
  console.log("Request");
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === config.FB_VERIFY_TOKEN
  ) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 *
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 */
app.post("/webhook/", function(req, res) {
  let data = req.body;
  console.log(JSON.stringify(data));

  // Make sure this is a page subscription
  if (data.object == "page") {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      let pageID = pageEntry.id;
      let timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          fbService.receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          fbService.receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          fbService.receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          fbService.receivedAccountLink(messagingEvent);
        } else {
          console.log(
            "Webhook received unknown messagingEvent:",
            messagingEvent
          );
        }
      });
    });

    // Assume all went well.
    // You must send back a 200, within 20 seconds
    res.sendStatus(200);
  }
});

function setSessionAndUser(senderID) {
  if (!sessionIds.has(senderID)) {
    sessionIds.set(senderID, uuid.v1());
  }

  if (!usersMap.has(senderID)) {
    userService.addUser(function(user) {
      usersMap.set(senderID, user);
    }, senderID);
  }
}

function receivedMessage(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;
  let timeOfMessage = event.timestamp;
  let message = event.message;

  setSessionAndUser(senderID);

  // console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
  // console.log(JSON.stringify(message));

  let isEcho = message.is_echo;
  let messageId = message.mid;
  let appId = message.app_id;
  let metadata = message.metadata;

  // You may get a text or attachment but not both
  let messageText = message.text;
  let messageAttachments = message.attachments;
  let quickReply = message.quick_reply;

  if (isEcho) {
    fbService.handleEcho(messageId, appId, metadata);
    return;
  } else if (quickReply) {
    handleQuickReply(senderID, quickReply, messageId);
    return;
  }

  if (messageText) {
    // send message to DialogFlow
    dialogflowService.sendTextQueryToDialogFlow(
      sessionIds,
      handleDialogFlowResponse,
      senderID,
      messageText
    );
  } else if (messageAttachments) {
    fbService.handleMessageAttachments(messageAttachments, senderID);
  }
}

function handleQuickReply(senderID, quickReply, messageId) {
  let quickReplyPayload = quickReply.payload;
  console.log(
    "Quick reply for message %s with payload %s",
    messageId,
    quickReplyPayload
  );
  //send payload to api.ai
  dialogflowService.sendTextQueryToDialogFlow(
    sessionIds,
    handleDialogFlowResponse,
    senderID,
    quickReplyPayload
  );
}

function handleDialogFlowAction(
  sender,
  action,
  messages,
  contexts,
  parameters
) {
  switch (action) {
    case "detailed-application":
      if (
        fbService.isDefined(contexts[0]) &&
        (contexts[0].name.includes("job_application") ||
          contexts[0].name.includes(
            "job-application-details_dialog_context"
          )) &&
        contexts[0].parameters
      ) {
        let phone_number =
          fbService.isDefined(contexts[0].parameters.fields["phone-number"]) &&
          contexts[0].parameters.fields["phone-number"] != ""
            ? contexts[0].parameters.fields["phone-number"].stringValue
            : "";
        let user_name =
          fbService.isDefined(contexts[0].parameters.fields["user-name"]) &&
          contexts[0].parameters.fields["user-name"] != ""
            ? contexts[0].parameters.fields["user-name"].stringValue
            : "";
        let previous_job =
          fbService.isDefined(contexts[0].parameters.fields["previous-job"]) &&
          contexts[0].parameters.fields["previous-job"] != ""
            ? contexts[0].parameters.fields["previous-job"].stringValue
            : "";
        let years_of_experience =
          fbService.isDefined(
            contexts[0].parameters.fields["years-of-experience"]
          ) && contexts[0].parameters.fields["years-of-experience"] != ""
            ? contexts[0].parameters.fields["years-of-experience"].stringValue
            : "";
        let job_vacancy =
          fbService.isDefined(contexts[0].parameters.fields["job-vacancy"]) &&
          contexts[0].parameters.fields["job-vacancy"] != ""
            ? contexts[0].parameters.fields["job-vacancy"].stringValue
            : "";

        if (
          phone_number == "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience == ""
        ) {
          let replies = [
            {
              content_type: "text",
              title: "Less than 1 year",
              payload: "Less than 1 year"
            },
            {
              content_type: "text",
              title: "Less than 10 years",
              payload: "Less than 10 years"
            },
            {
              content_type: "text",
              title: "More than 10 years",
              payload: "More than 10 years"
            }
          ];

          fbService.sendQuickReply(sender, messages[0].text.text[0], replies);
        } else if (
          phone_number != "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience != "" &&
          job_vacancy != ""
        ) {
          jobApplicationService(
            phone_number,
            user_name,
            previous_job,
            years_of_experience,
            job_vacancy
          );

          fbService.handleMessages(messages, sender);
        } else {
          fbService.handleMessages(messages, sender);
        }
      }
      break;
    case "get_weather":
      if (parameters.fields["geo-city"].stringValue != "") {
        weatherService(function(weatherResponse) {
          if (!weatherResponse) {
            fbService.sendTextMessage(
              sender,
              `No weather forecast available for ${
                parameters.fields["geo-city"].stringValue
              }`
            );
          } else {
            let reply = `${messages[0].text.text} ${weatherResponse}`;
            fbService.sendTextMessage(sender, reply);
          }
        }, parameters.fields["geo-city"].stringValue);
      } else {
        fbService.sendTextMessage(sender, "No weather forecast available");
      }

      break;
    case "iphone_colors":
      colorsService.readAllColors(function(allColors) {
        let allColorsString = allColors.join(", ");
        let reply = `${
          parameters.fields["iphone"].stringValue
        } is available in ${allColorsString}. What's your favourite color?`;

        sendTextMessage(sender, reply);
      });

      break;
    case "iphone_colors.favourite":
      colorsService.updateUserColor(
        parameters.fields["color"].stringValue,
        sender
      );
      let reply = `Oh, I like it, too. I'll remember that.`;
      fbService.sendTextMessage(sender, reply);

      break;
    case "buy-iphone":
      colorsService.readUserColor(function(color) {
        let reply;
        if (color === "") {
          reply = "In what color would you like to have it?";
        } else {
          reply = `Would you like to order it in your favourite color ${color}?`;
        }
        fbService.sendTextMessage(sender, reply);
      }, sender);

      break;
    default:
      // unhandled action, just send back the text
      fbService.handleMessages(messages, sender);
  }
}

function handleMessages(messages, sender) {
  let timeoutInterval = 1100;
  let previousType;
  let cardTypes = [];
  let timeout = 0;
  for (let i = 0; i < messages.length; i++) {
    if (
      previousType == "card" &&
      (messages[i].message != "card" || i == messages.length - 1)
    ) {
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    } else if (messages[i].message == "card" && i == messages.length - 1) {
      cardTypes.push(messages[i]);
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
    } else if (messages[i].message == "card") {
      cardTypes.push(messages[i]);
    } else {
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    }

    previousType = messages[i].message;
  }
}

function handleDialogFlowResponse(sender, response) {
  let responseText = response.fulfillmentMessages.fulfillmentText;

  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  fbService.sendTypingOff(sender);

  if (fbService.isDefined(action)) {
    handleDialogFlowAction(sender, action, messages, contexts, parameters);
  } else if (fbService.isDefined(messages)) {
    fbService.handleMessages(messages, sender);
  } else if (responseText == "" && !fbService.isDefined(action)) {
    //dialogflow could not evaluate input.
    fbService.sendTextMessage(
      sender,
      "I'm not sure what you want. Can you be more specific?"
    );
  } else if (fbService.isDefined(responseText)) {
    fbService.sendTextMessage(sender, responseText);
  }
}

async function resolveAfterXSeconds(x) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(x);
    }, x * 1000);
  });
}

async function greetUserText(userId) {
  let user = usersMap.get(userId);
  if (!user) {
    await resolveAfterXSeconds(2);
    user = usersMap.get(userId);
  }

  if (user) {
    sendTextMessage(
      userId,
      `Welcome ${
        user.first_name
      }! I perform job interviews. What can I help you with?`
    );
  } else {
    sendTextMessage(
      userId,
      "Welcome! I perform job interviews. What can I help you with?"
    );
  }
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 */
function receivedPostback(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;
  let timeOfPostback = event.timestamp;

  setSessionAndUser(senderID);

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  let payload = event.postback.payload;

  switch (payload) {
    case "GET_STARTED":
      greetUserText(senderID);
      break;
    case "JOB_APPLY":
      dialogflowService.sendEventToDialogFlow(
        sessionIds,
        handleDialogFlowResponse,
        senderID,
        "JOB_OPENINGS"
      );
      break;
    default:
      fbService.sendTextMessage(
        senderID,
        "I'm not sure what you want. Can you be more specific?"
      );
      break;
  }

  console.log(
    "Received postback for user %d and page %d with payload '%s' " + "at %d",
    senderID,
    recipientID,
    payload,
    timeOfPostback
  );
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 */
function receivedMessageRead(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  let watermark = event.read.watermark;
  let sequenceNumber = event.read.seq;

  console.log(
    "Received message read event for watermark %d and sequence " + "number %d",
    watermark,
    sequenceNumber
  );
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 */
function receivedAccountLink(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;

  let status = event.account_linking.status;
  let authCode = event.account_linking.authorization_code;

  console.log(
    "Received account link event with for user %d with status %s " +
      "and auth code %s ",
    senderID,
    status,
    authCode
  );
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 */
function receivedDeliveryConfirmation(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;
  let delivery = event.delivery;
  let messageIDs = delivery.mids;
  let watermark = delivery.watermark;
  let sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log(
        "Received delivery confirmation for message ID: %s",
        messageID
      );
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 */
function receivedAuthentication(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;
  let timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  let passThroughParam = event.optin.ref;

  console.log(
    "Received authentication for user %d and page %d with pass " +
      "through param '%s' at %d",
    senderID,
    recipientID,
    passThroughParam,
    timeOfAuth
  );

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 */
function verifyRequestSignature(req, res, buf) {
  let signature = req.headers["x-hub-signature"];

  if (!signature) {
    throw new Error("Couldn't validate the signature.");
  } else {
    let elements = signature.split("=");
    let method = elements[0];
    let signatureHash = elements[1];

    let expectedHash = crypto
      .createHmac("sha1", config.FB_APP_SECRET)
      .update(buf)
      .digest("hex");

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

// Spin up the server
app.listen(app.get("port"), function() {
  console.log("running on port", app.get("port"));
});
