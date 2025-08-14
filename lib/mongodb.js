import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI environment variable is missing')
  throw new Error('Please add your MongoDB URI to environment variables')
}

console.log('MongoDB URI exists:', !!uri)
console.log('Environment:', process.env.NODE_ENV)

const options = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 75000,
  connectTimeoutMS: 30000,
  bufferMaxEntries: 0,
  bufferCommands: false,
  maxIdleTimeMS: 30000,
  family: 4,
  retryWrites: true,
  retryReads: true
}

let client
let clientPromise

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options)
    global._mongoClientPromise = client.connect()
      .then(() => {
        console.log('MongoDB connected successfully (development)')
        return client
      })
      .catch(err => {
        console.error('MongoDB connection failed (development):', err)
        throw err
      })
  }
  clientPromise = global._mongoClientPromise
} else {
  client = new MongoClient(uri, options)
  clientPromise = client.connect()
    .then(() => {
      console.log('MongoDB connected successfully (production)')
      return client
    })
    .catch(err => {
      console.error('MongoDB connection failed (production):', err)
      throw err
    })
}

export default clientPromise
