export const STUDY_TYPE_MAP: Record<string, Record<string, string[]>> = {
  CT: {
    "Abdomen and pelvis": [
      "Abdomen", "Abdomen and pelvis", "Enterography", "Urinary tract",
      "Urography", "Virtual gastroscopy", "Virtual colonoscopy", "Liver volumetry"
    ],
    "Chest": [
      "Chest", "Chest and abdomen", "Chest, abdomen and pelvis", "Virtual bronchoscopy"
    ],
    "Head and Neck": [
      "Brain", "Facial", "Neck", "Orbits", "Petrous", "Paranasal", "Skull", "TMJ"
    ],
    "MSK": [
      "Shoulder","Arm","Elbow","Forearm","Wrist","Hand",
      "Pelvis and hips","Femur","Knee","Leg","Ankle","Foot"
    ],
    "Spine": ["Cervical","Dorsal","Lumbosacral","Whole spine"],
    "Angio": [
      "Cerebral","Cerebral and carotid","Aorta","Pulmonary",
      "Mesenteric","Renal","Upper limb","Lower limb"
    ]
  },
  MRI: {
    "Abdomen and pelvis": [
      "Abdomen","Abdomen and pelvis","Enterography","Urography",
      "Dynamic liver","Dynamic pancreas","Adrenals","MRCP",
      "Prostate","Fistula","Pelvis Male","Pelvis Female"
    ],
    "Chest": ["Chest","Chest and abdomen","Chest, abdomen and pelvis"],
    "Head and Neck": [
      "Brain","Facial","Neck","Orbits","Petrous","Paranasal",
      "Sella","TMJ","Brachial Plexus"
    ],
    "MSK": [
      "Shoulder","Arm","Elbow","Forearm","Wrist","Hand",
      "Pelvis and hips","Femur","Knee","Leg","Ankle","Foot","Sacroiliac"
    ],
    "Spine": ["Cervical Spine","Dorsal Spine","Lumbar Spine","Whole spine"],
    "Angio": [
      "MRA Brain","MRV Brain","MRA Aorta","MRA abdomen","MRA Renal",
      "MRA Upper limb","MRA Lower limb","Brain venography",
      "Upper limb venography","Lower limb venography"
    ]
  },
  "PET CT": {
    "PET CT": ["Whole body PET CT"]
  },
  "X-ray": {
    "X-ray": [
      "Abdomen","MCUG","Ankle","Long bone","Barium enema","Barium follow through",
      "Barium meal","Barium swallow","Cervical spine","Chest","Coccyx","Dorsal spine",
      "Elbow","Foot","Hand","Heels","Hips","HSG","IVP","Knee","Lumbar spine",
      "Nasopharynx","PNS","PUT","Sacroiliac joints","Shoulder","Skull","TMJ","Wrist"
    ]
  },
  "Ultrasound": {
    "Ultrasound": [
      "Abdomen","Pelvis Female","Pelvis Male","Obstetric","Thyroid","Breast",
      "Scrotal","Musculoskeletal",
      "LL Arterial Doppler","UL Arterial Doppler",
      "LL Venous Doppler","UL Venous Doppler"
    ]
  }
};

export const PAIRED_ORGANS = [
  "Shoulder","Arm","Elbow","Forearm",
  "Wrist","Hand","Knee","Leg","Ankle",
  "Foot","Pelvis and hips","Femur","Hips","Heels",
  "Orbits","Petrous","TMJ",
  "Brachial Plexus","Sacroiliac","Adrenals",
  "Sacroiliac joints","Scrotal","Breast","Musculoskeletal",
  "Renal","Upper limb","Lower limb",
  "LL Arterial Doppler","UL Arterial Doppler",
  "LL Venous Doppler","UL Venous Doppler"
];

