"""Start the shop app:  python run.py   (then open http://localhost:5000)

Set HOST=0.0.0.0 to let other devices on the shop Wi-Fi open it.
Use `waitress-serve --listen=0.0.0.0:5000 --call app:create_app` for a sturdier server (see README).
"""
import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)),
            debug=os.environ.get("FLASK_DEBUG") == "1")
