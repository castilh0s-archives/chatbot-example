const config = require("../config");

module.exports = {
  sendEmail: function(subject, content) {
    let helper = require("sendgrid").mail;

    let from_email = new helper.Email(config.EMAIL_FROM);
    let to_email = new helper.Email(config.EMAIL_TO);
    let subject = subject;
    let content = new helper.Content("text/html", content);
    let mail = new helper.Mail(from_email, subject, to_email, content);

    let sg = require("sendgrid")(config.SENGRID_API_KEY);
    let request = sg.emptyRequest({
      method: "POST",
      path: "/v3/mail/send",
      body: mail.toJSON()
    });

    sg.API(request, function(error, response) {
      console.log(response.statusCode);
      console.log(response.body);
      console.log(response.headers);
    });
  }
};
