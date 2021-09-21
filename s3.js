require('dotenv').config();
const S3 = require('aws-sdk/clients/s3');
const { v4: uuidv4 } = require('uuid');
const jimp = require('jimp');
const regex = /^data:image\/\w+;base64,/;

const bucketName = process.env.AWS_BUCKET_NAME;
const region = process.env.AWS_BUCKET_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY;
const secretAccessKey = process.env.AWS_SECRET_KEY;

class S3Service {
  sizes = [
    {
      ratio: 1,
      path: 'original_size'
    },
    {
      ratio: 0.5,
      path: '50%_resize'
    },
    {
      ratio: 0.25,
      path: '25%_resize'
    },
    {
      ratio: 0.1,
      path: '10%_resize'
    }
  ];
  
  s3 = new S3({
    region,
    accessKeyId,
    secretAccessKey,
    signatureVersion: 'v4'
  });

  // uploading image with original size
  uploadFile = async (file, fileName) => {
    const buf = Buffer.from(file.replace(regex, ''), 'base64');
    const jimpImage = await jimp.read(buf);
    const mime = jimpImage.getMIME();
    const uploadPromises = [];
    for (let size of this.sizes) {
      // create a resized image based on size.ratio
      const new_w = Math.floor(jimpImage.bitmap.width * size.ratio);
      const new_h = Math.floor(jimpImage.bitmap.height * size.ratio);
      const resizedImageBuffer = await jimpImage.resize(new_w, new_h).getBufferAsync(mime);
      const newFileName = `${size.path}/${fileName}`;
      const uploadParams = {
        Bucket: bucketName,
        Body: resizedImageBuffer,
        Key: newFileName,
        ContentType: mime
      };
      uploadPromises.push(this.s3.upload(uploadParams).promise());
    }
    return await Promise.all(uploadPromises);
  };

  // getting all files from s3
  getFiles = async () => {
    const keyNames = await this.listFiles();
    const data = [];

    for (const item of keyNames.Contents) {
      const params = {
        Bucket: bucketName,
        Key: item.Key
      };

      const signedUrl = await this.s3.getSignedUrl('getObject', params).promise();
      data.push({
        name: item.Key,
        image: signedUrl
      });
    }
    return data;
  };

  // get individual file
  getFile = async fileKey => {
    const result = await this.s3
      .getObject({
        Bucket: bucketName,
        Key: fileKey
      })
      .promise();

    return result;
  };

  listFiles = async () => {
    const result = await this.s3
      .listObjectsV2({
        Bucket: bucketName,
        Prefix: '25%_resize'
      })
      .promise();

    return result;
  };

  deleteFiles = async fileKey => {
    // const deletePromises = [];
    const params = {
      Bucket: bucketName,
      Delete: {
        Objects: [],
        Quiet: false  
      }          
    };
    for (let size of this.sizes) {
      params.Delete.Objects.push({Key: `${size.path}/${fileKey}`});
    }
    try{
      const data = await this.s3.deleteObjects(params).promise();
      return data;
    }catch (err){
      return err;
    }
  };

  getSignedUrl = async fileKey => {
    const splitFileKey = fileKey.split('/');

    const params = {
      Bucket: bucketName,
      Key: `original_size/${splitFileKey[1]}`
    };

    result = await s3.getSignedUrl('getObject', params, (err, data) => {
      if (err) {
        return err;
      }

      const returnData = {
        signedRequest: data
      };

      return returnData;
    });
  }
}

exports.S3Service = S3Service;
