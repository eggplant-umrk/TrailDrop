from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="TrailDrop API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"status": "ok", "service": "TrailDrop API"}


# TODO: include routers, e.g.
# from routers import pickups, workshops
# app.include_router(pickups.router)
# app.include_router(workshops.router)
