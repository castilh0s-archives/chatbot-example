const dialogflow = require("dialogflow");
const config = require("./config");
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const request = require("request");
const app = express();
const uuid = require("uuid");

// Messenger API parameters
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

app.set("port", process.env.PORT || 5000);

//verify request came from facebook
app.use(
  bodyParser.json({
    verify: verifyRequestSignature
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

// Index route
app.get("/", function(req, res) {
  res.send("Hello world, I am a chat bot");
});

// for Facebook verification
app.get("/webhook/", function(req, res) {
  console.log("request");
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
 *
 */
app.post("/webhook/", function(req, res) {
  let data = req.body;
  console.log(JSON.stringify(data));

  // Make sure this is a page subscription
  if (data.object == "page") {
    console.log("Yes, the object is a page...");

    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      let pageID = pageEntry.id;
      let timeOfEvent = pageEntry.time;

      console.log(`Page ID: ${pageID}`);
      console.log(`Time of Event: ${timeOfEvent}`);

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        console.log(`Messaging event: ${JSON.stringify(messagingEvent)}`);

        if (messagingEvent.optin) {
          console.log("Received authentication");
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          console.log("Received message");
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          console.log("Received delivery confirmation");
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          console.log("Received postback");
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          console.log("Received message read");
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          console.log("Received account link");
          receivedAccountLink(messagingEvent);
        } else {
          console.log(
            "Webhook received unknown messagingEvent: ",
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

function receivedMessage(event) {
  let senderID = event.sender.id;
  let recipientID = event.recipient.id;
  let timeOfMessage = event.timestamp;
  let message = event.message;

  if (!sessionIds.has(senderID)) {
    sessionIds.set(senderID, uuid.v1());
  }

  console.log(
    "Received message for user %d and page %d at %d.",
    senderID,
    recipientID,
    timeOfMessage
  );
  console.log("Message: " + JSON.stringify(message));

  let isEcho = message.is_echo;
  let messageId = message.mid;
  let appId = message.app_id;
  let metadata = message.metadata;

  // You may get a text or attachment but not both
  let messageText = message.text;
  let messageAttachments = message.attachments;
  let quickReply = message.quick_reply;

  if (isEcho) {
    handleEcho(messageId, appId, metadata);
    return;
  } else if (quickReply) {
    handleQuickReply(senderID, quickReply, messageId);
    return;
  }

  if (messageText) {
    console.log("Sending to DialogFlow");
    sendToDialogFlow(senderID, messageText);
  } else if (messageAttachments) {
    console.log("Handling message attachments");
    handleMessageAttachments(messageAttachments, senderID);
  }
}

function handleMessageAttachments(messageAttachments, senderID) {
  //for now just reply
  sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
  let quickReplyPayload = quickReply.payload;
  console.log(
    "Quick reply for message %s with payload %s",
    messageId,
    quickReplyPayload
  );
  //send payload to api.ai
  sendToDialogFlow(senderID, quickReplyPayload);
}

// https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-echo
function handleEcho(messageId, appId, metadata) {
  // Just logging message echoes to console
  console.log(
    "Received echo for message %s and app %d with metadata %s",
    messageId,
    appId,
    metadata
  );
}

function handleDialogFlowAction(
  sender,
  action,
  messages,
  contexts,
  parameters
) {
  console.log("Handling action:", action);
  switch (action) {
    case "detailed-application":
      console.log("This is the context:", JSON.stringify(contexts[0]));
      console.log("Ok, here we go...");
      console.log("Context is defined?", isDefined(contexts[0]));
      console.log("");
      if (
        isDefined(contexts[0]) &&
        (contexts[0].name.includes("job_application") ||
          contexts[0].name.includes("job-application-details_dialog_context") ||
          contexts[0].name.includes("dialog_context")) &&
        contexts[0].parameters
      ) {
        console.log("I'm a job_application");
        let phone_number =
          isDefined(contexts[0].parameters.fields["phone-number"]) &&
          contexts[0].parameters.fields["phone-number"] != ""
            ? contexts[0].parameters.fields["phone-number"].stringValue
            : "";
        let user_name =
          isDefined(contexts[0].parameters.fields["user-name"]) &&
          contexts[0].parameters.fields["user-name"] != ""
            ? contexts[0].parameters.fields["user-name"].stringValue
            : "";
        let previous_job =
          isDefined(contexts[0].parameters.fields["previous-job"]) &&
          contexts[0].parameters.fields["previous-job"] != ""
            ? contexts[0].parameters.fields["previous-job"].stringValue
            : "";
        let years_of_experience =
          isDefined(contexts[0].parameters.fields["years-of-experience"]) &&
          contexts[0].parameters.fields["years-of-experience"] != ""
            ? contexts[0].parameters.fields["years-of-experience"].stringValue
            : "";
        let job_vacancy =
          isDefined(contexts[0].parameters.fields["job-vacancy"]) &&
          contexts[0].parameters.fields["job-vacancy"] != ""
            ? contexts[0].parameters.fields["job-vacancy"].stringValue
            : "";

        if (
          phone_number == "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience == ""
        ) {
          console.log("Years of experience quick replies");
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

          sendQuickReply(sender, messages[0].text.text[0], replies);
        } else if (
          phone_number != "" &&
          user_name != "" &&
          previous_job != "" &&
          years_of_experience != "" &&
          job_vacancy != ""
        ) {
          console.log("Creating the e-mail body");
          let emailContent =
            "A new job enquiery from " +
            user_name +
            " for the job: " +
            job_vacancy +
            ".<br> Previous job position: " +
            previous_job +
            "." +
            ".<br> Years of experience: " +
            years_of_experience +
            "." +
            ".<br> Phone number: " +
            phone_number +
            ".";

          sendEmail("New job application", emailContent);

          handleMessages(messages, sender);
        } else {
          handleMessages(messages, sender);
        }
      }
      break;
    case "get-dash-weather":
      if (
        parameters.fields.hasOwnProperty("geo-city") &&
        parameters.fields["geo-city"].stringValue != ""
      ) {
        request(
          {
            url: "http://api.openweathermap.org/data/2.5/weather",
            qs: {
              appid: config.WEATHER_API_KEY,
              q: parameters.fields["geo-city"].stringValue
            }
          },
          function(error, response, body) {
            if (response.statusCode === 200) {
              let weather = JSON.parse(body);
              if (weather.hasOwnProperty("weather")) {
                let reply = `${messages[0].text.text} ${
                  weather["weather"][0]["description"]
                }`;
                sendTextMessage(sender, reply);
              } else {
                sendTextMessage(
                  sender,
                  `No weather forecast available for ${
                    parameters.fields["geo-city"].stringValue
                  }`
                );
              }
            } else {
              console.log("OpenWeatherMap Error:", error);
              sendTextMessage(sender, "Weather forecast is not available");
            }
          }
        );
      } else {
        handleMessages(messages, sender);
      }
      break;
    default:
      // unhandled action, just send back the text
      handleMessages(messages, sender);
  }
}

function handleMessage(message, sender) {
  switch (message.message) {
    case "text": //text
      message.text.text.forEach(text => {
        if (text !== "") {
          sendTextMessage(sender, text);
        }
      });
      break;
    case "quickReplies": //quick replies
      let replies = [];
      message.quickReplies.quickReplies.forEach(text => {
        let reply = {
          content_type: "text",
          title: text,
          payload: text
        };
        replies.push(reply);
      });
      sendQuickReply(sender, message.quickReplies.title, replies);
      break;
    case "image": //image
      sendImageMessage(sender, message.image.imageUri);
      break;
  }
}

function handleCardMessages(messages, sender) {
  let elements = [];
  for (let m = 0; m < messages.length; m++) {
    let message = messages[m];
    let buttons = [];
    for (let b = 0; b < message.card.buttons.length; b++) {
      let isLink = message.card.buttons[b].postback.substring(0, 4) === "http";
      let button;
      if (isLink) {
        button = {
          type: "web_url",
          title: message.card.buttons[b].text,
          url: message.card.buttons[b].postback
        };
      } else {
        button = {
          type: "postback",
          title: message.card.buttons[b].text,
          payload: message.card.buttons[b].postback
        };
      }
      buttons.push(button);
    }

    let element = {
      title: message.card.title,
      image_url: message.card.imageUri,
      subtitle: message.card.subtitle,
      buttons: buttons
    };
    elements.push(element);
  }
  sendGenericMessage(sender, elements);
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
  console.log("Handling DialogFlow response...");
  let responseText = response.fulfillmentMessages.fulfillmentText;

  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  sendTypingOff(sender);

  if (isDefined(action)) {
    console.log("Handling DialogFlow action");
    handleDialogFlowAction(sender, action, messages, contexts, parameters);
  } else if (isDefined(messages)) {
    console.log("Handling messages");
    handleMessages(messages, sender);
  } else if (responseText == "" && !isDefined(action)) {
    console.log("Sending text message");
    //dialogflow could not evaluate input.
    sendTextMessage(
      sender,
      "I'm not sure what you want. Can you be more specific?"
    );
  } else if (isDefined(responseText)) {
    sendTextMessage(sender, responseText);
  }
}

async function sendToDialogFlow(sender, textString, params) {
  sendTypingOn(sender);

  try {
    const sessionPath = sessionClient.sessionPath(
      config.GOOGLE_PROJECT_ID,
      sessionIds.get(sender)
    );

    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: textString,
          languageCode: config.DF_LANGUAGE_CODE
        }
      },
      queryParams: {
        payload: {
          data: params
        }
      }
    };
    const responses = await sessionClient.detectIntent(request);

    const result = responses[0].queryResult;
    console.log("DialogFlow result response:", JSON.stringify(result));
    handleDialogFlowResponse(sender, result);
  } catch (e) {
    console.log("error");
    console.log(e);
  }
}

function sendTextMessage(recipientId, text) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text
    }
  };

  console.log("Sending an text message...");
  callSendAPI(messageData);
}

/*
 * Send an image using the Send API.
 */
function sendImageMessage(recipientId, imageUrl) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: imageUrl
        }
      }
    }
  };

  console.log("Sending a image message...");
  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 */
function sendGifMessage(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: config.SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  console.log("Sending an gif message...");
  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 */
function sendAudioMessage(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: config.SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  console.log("Sending a audio message...");
  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example videoName: "/assets/allofus480.mov"
 */
function sendVideoMessage(recipientId, videoName) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: config.SERVER_URL + videoName
        }
      }
    }
  };

  console.log("Sending an video message...");
  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example fileName: fileName"/assets/test.txt"
 */
function sendFileMessage(recipientId, fileName) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: config.SERVER_URL + fileName
        }
      }
    }
  };

  console.log("Sending an file message...");
  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 */
function sendButtonMessage(recipientId, text, buttons) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text,
          buttons: buttons
        }
      }
    }
  };

  console.log("Sending an button message...");
  callSendAPI(messageData);
}

function sendGenericMessage(recipientId, elements) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: elements
        }
      }
    }
  };

  console.log("Sending an generic message...");
  callSendAPI(messageData);
}

function sendReceiptMessage(
  recipientId,
  recipient_name,
  currency,
  payment_method,
  timestamp,
  elements,
  address,
  summary,
  adjustments
) {
  // Generate a random receipt ID as the API requires a unique ID
  let receiptId = "order" + Math.floor(Math.random() * 1000);

  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: recipient_name,
          order_number: receiptId,
          currency: currency,
          payment_method: payment_method,
          timestamp: timestamp,
          elements: elements,
          address: address,
          summary: summary,
          adjustments: adjustments
        }
      }
    }
  };

  console.log("Sending an receipt message...");
  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 */
function sendQuickReply(recipientId, text, replies, metadata) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text,
      metadata: isDefined(metadata) ? metadata : "",
      quick_replies: replies
    }
  };

  console.log("Sending an quick reply...");
  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 */
function sendReadReceipt(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  console.log("Sending an read receipt...");
  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 */
function sendTypingOn(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  console.log("Sending an typing on...");
  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 */
function sendTypingOff(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  console.log("Sending an typing off...");
  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 */
function sendAccountLinking(recipientId) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons: [
            {
              type: "account_link",
              url: config.SERVER_URL + "/authorize"
            }
          ]
        }
      }
    }
  };

  console.log("Sending an account linking...");
  callSendAPI(messageData);
}

function greetUserText(userId) {
  // first read user firstname
  request(
    {
      uri: "https://graph.facebook.com/v2.7/" + userId,
      qs: {
        access_token: config.FB_PAGE_TOKEN
      }
    },
    function(error, response, body) {
      if (!error && response.statusCode == 200) {
        var user = JSON.parse(body);

        if (user.first_name) {
          console.log(
            "FB user: %s %s, %s",
            user.first_name,
            user.last_name,
            user.gender
          );

          sendTextMessage(
            userId,
            "Welcome " +
              user.first_name +
              "! " +
              "I perform job interviews. What can I help you with?"
          );
        } else {
          console.log("Cannot get data for FaceBook user with id:", userId);
        }
      } else {
        console.error(response.error);
      }
    }
  );
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 */
function callSendAPI(messageData) {
  request(
    {
      uri: "https://graph.facebook.com/v3.2/me/messages",
      qs: {
        access_token: config.FB_PAGE_TOKEN
      },
      method: "POST",
      json: messageData
    },
    function(error, response, body) {
      if (!error && response.statusCode == 200) {
        let recipientId = body.recipient_id;
        let messageId = body.message_id;

        if (messageId) {
          console.log(
            "Successfully sent message with id %s to recipient %s",
            messageId,
            recipientId
          );
        } else {
          console.log(
            "Successfully called Send API for recipient %s",
            recipientId
          );
        }
      } else {
        console.error(
          "Failed calling Send API",
          response.statusCode,
          response.statusMessage,
          body.error
        );
      }
    }
  );
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

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  let payload = event.postback.payload;

  switch (payload) {
    case "GET_STARTED":
      greetUserText(senderID);
      break;
    default:
      //unindentified payload
      sendTextMessage(
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

function sendEmail(subject, content) {
  console.log("Sending e-mail...");
  const sgMail = require("@sendgrid/mail");
  sgMail.setApiKey(config.SENDGRID_API_KEY);

  const msg = {
    to: config.EMAIL_TO,
    from: config.EMAIL_FROM,
    subject: subject,
    text: content,
    html: `<p>${content}</p>`
  };

  sgMail.send(msg);
  console.log("E-mail send!");
}

function isDefined(obj) {
  if (typeof obj == "undefined") {
    return false;
  }

  if (!obj) {
    return false;
  }

  return obj != null;
}

// Spin up the server
app.listen(app.get("port"), function() {
  console.log("running on port", app.get("port"));
});
