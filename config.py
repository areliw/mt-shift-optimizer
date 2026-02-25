# config.py

mt_list = [
    {"name": "อาหลิว",   "type": "parttime", "off_days": [0,1,2,3,4,5], "skills": ["donor"]},
    {"name": "พี่เบส",   "type": "fulltime",  "off_days": [5, 6],        "skills": ["donor", "xmatch"]},
    {"name": "พี่หน่อย", "type": "fulltime",  "off_days": [],             "skills": ["donor", "xmatch"]},
    {"name": "พี่อัล",   "type": "fulltime",  "off_days": [6],            "skills": ["xmatch"]},
    {"name": "พี่อิ๋ว",  "type": "fulltime",  "off_days": [],             "skills": ["donor", "xmatch"]},
    {"name": "พี่แชมพู", "type": "fulltime",  "off_days": [0, 1],        "skills": ["xmatch"]},
    {"name": "ชมพู่",    "type": "fulltime",  "off_days": [],             "skills": ["donor", "xmatch"]},
    {"name": "พี่ตอย",   "type": "fulltime",  "off_days": [5, 6],        "skills": ["xmatch"]},
    {"name": "พี่ผิง",   "type": "fulltime",  "off_days": [],             "skills": ["donor", "xmatch"]},
    {"name": "พี่แหม่ม", "type": "fulltime",  "off_days": [3],            "skills": ["donor", "xmatch"]},
]

shift_list = [
    {"name": "Morning",   "donor": 1, "xmatch": 1},
    {"name": "Afternoon", "donor": 1, "xmatch": 1},
    {"name": "Night",     "donor": 1, "xmatch": 1},
]
num_days = 10