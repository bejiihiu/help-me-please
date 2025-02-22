const mongoose = require("mongoose");

const postSchema = new mongoose.Schema({
  _id: { type: String, default: "singleton" },
  lastPost: { type: Number, default: 0 },
  nextPost: { type: Number, default: 0 },
});

const PostModel = mongoose.model("Post", postSchema);

module.exports = PostModel;
