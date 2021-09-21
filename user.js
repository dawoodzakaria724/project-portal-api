require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const S3 = require('aws-sdk/clients/s3');
const { S3Service } = require('./s3');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');

const payload = {
  iss: process.env.ZOOM_API_KEY,
  exp: new Date().getTime() + 5000
};

const bucketName = process.env.AWS_BUCKET_NAME;
const region = process.env.AWS_BUCKET_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY;
const secretAccessKey = process.env.AWS_SECRET_KEY;

const s3 = new S3({
  region,
  accessKeyId,
  secretAccessKey,
  signatureVersion: 'v4'
});

const S3ServiceInstance = new S3Service();

function createRouter(db) {
  const userUpload = async (req, res) => {
    let result = null;
    let status = 200;
    try{
      const file = req.body.encoded_file;
      const file_name = req.body.encoded_file_name;
      result = await S3ServiceInstance.uploadFile(file, file_name);
    } catch (err){
      result = err;
      status = 500;
    } finally{
      console.log(result)
      res.status(status);
      res.send(result);
    }
  };
  const userDelete = async (req, res) => {
    const file = req.body.key;
    const splitFile = file.split('/');
    const result = await S3ServiceInstance.deleteFiles(splitFile[1]);
    res.send(result);
  };
  const userGet = async (req, res) => {
    const result = await S3ServiceInstance.getFiles();
    res.send(result);
  };
  const userGetOriginal = async (req, res) => {
    const fileKey = req.body.key;

    const result = await S3ServiceInstance.getSignedUrl(fileKey);

    res.write(JSON.stringify(result));
    res.end();
  };

  const userRegister = async (req, res, next) => {
    // todo store a hashed_password in hash
    let hash = bcrypt.hashSync(req.body.pass, 10);
    try {
      const [result] = await db.query('INSERT INTO user (email, hashed_password) VALUES (:email,:hashed_password)', 
      {email:req.body.email, hashed_password:hash});
      await db.commit();
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.log(err);
      res.status(500).json({ status: 'error', err });
    }
  };

  const userLogin = async function (req, res, next) {
    try {
      const [results] = await db.query(`SELECT * FROM user WHERE email = :email`, {email: req.body.email});
      let log = null;
      for (const user of results) {
        if (
          user.hashed_password &&
          req.body.password &&
          bcrypt.compareSync(req.body.password, user.hashed_password.toString())
        ) {
          log = { id: user.id, email: user.email, timeCreated: new Date().toLocaleString() };
          console.log(`success: ${user.id}`);
        }
      }

      if (log) {
        jwt.sign(log, process.env.JWT_SECRET, (err, token) => {
          res.status(200).json({
            token: token
          });
        });
      } else {
        res.status(200).json({ message: 'Incorrect password' });
      }
    } catch (err) {
      console.log(err);
      res.status(500).json({ status: 'error', err });
    }
  };

  const createMeeting = async (req, res) => {
    // payload should be made dynamically, not a constant in the file.
    const meetingPayload = {
      iss: process.env.ZOOM_API_KEY,
      exp: new Date().getTime() + 10000
    };
    const token = jwt.sign(meetingPayload, process.env.ZOOM_API_SECRET);

    const topic = req.body.name;
    const start_time = req.body.date;
    const agenda = req.body.agenda;
    const attendees = req.body.attendees;
    const user = req.body.user;

    try {
      const response = await axios({
        method: 'POST',
        url: 'https://api.zoom.us/v2/users/' + process.env.ZOOM_SENDER + '/meetings',
        data: {
          topic: topic,
          type: 2,
          start_time: start_time,
          duration: 60,
          password: 'test',
          agenda: agenda,
          settings: {
            host_video: 'true',
            participant_video: 'true'
          }
        },
        headers: {
          Authorization: 'Bearer' + token,
          'User-Agent': 'Zoom-api-Jwt-Request',
          'content-type': 'application/json'
        },
        json: true
      });
      // save the meeting (without attendees)
      const insertResult = await db.query(
        'INSERT INTO meetings (name, date, zoom_id, agenda, password) VALUES (:name,:date,:zoom_id,:agenda,:password)',
        {name: response.data.topic, date:response.data.start_time, 
          zoom_id:response.data.id, agenda:response.data.agenda, password:response.data.password}
      );
      // now save the attendees....
      const insertPromises = [];
      for (const email of attendees) {
        insertPromises.push(
          db.query(`INSERT INTO attendees (zoom_id, email) VALUES (:zoom_id ,:email)`, {zoom_id:response.data.id, email})
        );
      }
      await Promise.all(insertPromises);
      await db.commit();

      sgMail.setApiKey(process.env.SENDGRID_API_KEY);

      for (let i = 0; i < attendees.length; i++) {
        const message = {
          to: attendees[i],
          from: user,
          subject: `${topic} Zoom Meeting`,
          text: `
          Greetings ${attendees[i]},

          You Have been invited to a scheduled Zoom Meeting by ${user}
          set to start on ${start_time.substring(0, 10)}.

          Meeting ID: ${response.data.id}
          Join URL: ${response.data.join_url}

          Sincerely,
          ${user}
        `,
          html: `
          <p>Greetings ${attendees[i]},</p><br>
          <p>You have been invited to a scheduled <span style="font-weight:bold">Zoom Meeting</span> by 
          ${user} set to start on <span style="font-weight:bold">${start_time.substring(0, 10)}.
          </span></p><br>
          <p>Meeting ID: ${response.data.id}</p>
          <p>Join URL: <a href="${response.data.join_url}">${response.data.join_url}</a></p><br>
          <p>Sincerely,</p>
          <p>${user}</p>
        `
        };
        sgMail
          .send(message)
          .then(function (response) {
            console.log('email sent');
            res.send(response);
          })
          .catch(error => console.log(error.message));
      }

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.log(err);
      res.status(500).json({ status: 'error', error: JSON.stringify(err) });
    }
  };

  const getMeetings = async (req, res) => {
    const payload2 = {
      iss: process.env.ZOOM_API_KEY,
      exp: new Date().getTime() + 5000
    };
    const token = jwt.sign(payload2, process.env.ZOOM_API_SECRET);
    try {
      const response = await axios({
        method: 'GET',
        url: 'https://api.zoom.us/v2/users/' + process.env.ZOOM_SENDER + '/meetings',
        data: {
          userdId: process.env.ZOOM_SENDER,
          type: 'scheduled'
        },
        headers: {
          Authorization: 'Bearer' + token,
          'User-Agent': 'Zoom-api-Jwt-Request',
          'content-type': 'application/json'
        },
        json: true
      });
      // handle success
      const data = [];
      for (const meeting of response.data.meetings) {
        const id = meeting.id;
        const [attendees_data] = await db.query(`SELECT email from attendees where zoom_id = :zoom_id`, {zoom_id:id});
        const attendees = [];
        for (const attendee of attendees_data) {
          attendees.push(attendee.email);
        }
        data.push({ meeting, attendees });
      }
      // result is something like [{meeting:{},attendees:[]},{},{}]
      res.send(data);
    } catch (err) {
      console.log(err);
      res.status(500).json({ status: 'error', err });
    }
  };

  const deleteMeeting = async (req, res) => {
    const payload2 = {
      iss: process.env.ZOOM_API_KEY,
      exp: new Date().getTime() + 5000
    };
    const token = jwt.sign(payload2, process.env.ZOOM_API_SECRET);
    const id = req.params.id;

    try {
      const response = await axios({
        method: 'DELETE',
        url: 'https://api.zoom.us/v2/meetings/' + id,
        data: {
          meetingId: id,
          schedule_for_reminder: false
        },
        headers: {
          Authorization: 'Bearer' + token,
          'User-Agent': 'Zoom-api-Jwt-Request',
          'content-type': 'application/json'
        },
        json: true
      });

      // delete the meeting (without attendees)
      await db.query(`DELETE FROM meetings where zoom_id = :zoom_id`, {zoom_id:id});

      // now delete the attendees....
      await db.query(`DELETE FROM attendees where zoom_id = :zoom_id`, {zoom_id:id});

      await db.commit();
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.log(err);
      res.status(500).json({ status: 'error', error: JSON.stringify(err) });
    }
  };

  const sendEmail = async (req, res) => {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const message = {
      to: req.body.email,
      from: process.env.SENDGRID_SENDER,
      subject: 'Zoom Meeting',
      text: 'This is the text',
      html: `<h1>this is the html</h1>`
    };
    sgMail
      .send(message)
      .then(function (response) {
        console.log('email sent');
        res.send(response);
      })
      .catch(error => console.log(error.message));
  };

  const router = express.Router();
  // routes are defined here
  // register
  router.post('/user/register', userRegister);
  // auth/login request
  router.post('/user/login', userLogin);
  // router.use(verifyToken); //Re-enable when you figure out how to pass the token on the front end
  router.post('/user/upload', userUpload);
  router.post('/user/delete', userDelete);
  router.get('/user/get', userGet);
  // get only the original size of image from s3
  router.post('/user/getOriginal', userGetOriginal);
  // zoom api POST request to create meeting
  router.post('/user/createMeeting', createMeeting);
  router.get('/user/getMeetings', getMeetings);
  router.post('/user/sendEmail', sendEmail);
  router.delete('/user/deleteMeeting/:id', deleteMeeting);

  return router;
}

// format of token
// authorization: Bearer <access_token>

// verify token
async function verifyToken(req, res, next) {
  try {
    // get auth header value
    console.log(JSON.stringify(req.headers));
    const bearerHeader = req.headers.authorization;
    // split at the space
    const bearer = bearerHeader.trim().split(' ');
    // get token from array
    const bearerToken = bearer[1];
    // verify that this token is something you've signed.
    const payload = jwt.verify(bearerToken, process.env.JWT_SECRET);
    if (!payload) {
      throw new Error("Jwt wasn't signed by this application");
    }
    req.user = {};
    for (const key of Object.keys(payload)) {
      req.user[key] = payload[key];
    }
    // set the token
    req.token = bearerToken;
  } catch (err) {
    console.log(err);
    res.sendStatus(403);
    return;
  }
  // next middleware
  await next();
}

module.exports = createRouter;
