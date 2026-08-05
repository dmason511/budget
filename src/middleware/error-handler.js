function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    error: message,
  });
}

module.exports = errorHandler;
