// Commercial content: stored ONLY in the Backend repository.
// Do not copy these detailed progression phases to GitHub Pages, PWA caches,
// source maps, public repositories of frontend assets, or error responses.
// Generic educational guidance, NOT an automatically prescribed personal plan.
const progressions = Object.freeze({
  mass3: {
    ru: {
      heading: 'Прогрессия набора массы на 8 недель',
      introduction: 'Работай с весом, при котором остаются 2–3 технически чистых повтора в запасе. Не увеличивай нагрузку ценой техники.',
      phases: [
        {weeks:'1–2',title:'Подбор рабочей нагрузки',action:'Начни с нижней границы повторений. Запиши выполненные подходы и ощущения.',check:'Оставляй 2–3 повтора в запасе'},
        {weeks:'3–4',title:'Прибавка повторений',action:'При сохранении техники постепенно приближайся к верхней границе диапазона повторений.',check:'Одинаковая техника во всех подходах'},
        {weeks:'5–6',title:'Малая прибавка веса',action:'Когда выполняешь верхний предел повторений без потери формы, увеличь нагрузку минимально доступным шагом.',check:'После прибавки повторения могут вернуться к нижней границе'},
        {weeks:'7',title:'Закрепление',action:'Сохраняй рабочие веса, при необходимости добавляй один повтор в подходе, не работай через боль.',check:'Отдых и устойчивое самочувствие важнее рекорда'},
        {weeks:'8',title:'Разгрузка и оценка',action:'Сократи количество рабочих подходов примерно на треть–половину и сравни результаты с первой неделей.',check:'Сохрани качественную технику'}
      ]
    },
    en: {
      heading:'8-week muscle-gain progression',
      introduction:'Use a load that leaves 2–3 technically sound reps in reserve. Never trade form for extra weight.',
      phases:[
        {weeks:'1–2',title:'Find your training load',action:'Start at the low end of the rep range and log completed sets and effort.',check:'Keep 2–3 reps in reserve'},
        {weeks:'3–4',title:'Build repetitions',action:'Progress toward the high end of each rep range while maintaining technique.',check:'Consistent form across all sets'},
        {weeks:'5–6',title:'Small weight increases',action:'Once all sets meet the upper rep target with good form, add the smallest available weight increment.',check:'It is normal to return to the low end of the rep range'},
        {weeks:'7',title:'Consolidate',action:'Maintain loads and optionally add a rep without pushing through pain.',check:'Recovery matters more than records'},
        {weeks:'8',title:'Deload and assess',action:'Reduce working sets by roughly one-third to one-half and compare with week one.',check:'Prioritize sound technique'}
      ]
    }
  },
  strength4: {
    ru:{heading:'Прогрессия силы на 8 недель',introduction:'Контроль техники и достаточный отдых обязательны. При сомнениях в технике работай с тренером.',phases:[
      {weeks:'1–2',title:'Базовые подходы',action:'Подбери консервативные веса для 5×5, оставляя запас до отказа.',check:'Повторы одинаковой глубины и амплитуды'},
      {weeks:'3–4',title:'Точное выполнение 5×5',action:'Увеличивай вес только при уверенных пяти подходах по пять повторений.',check:'Долгие паузы между тяжёлыми подходами'},
      {weeks:'5–6',title:'Проверка устойчивости',action:'При замедлении техники повтори вес следующую тренировку вместо прибавки.',check:'Стабильная техника важнее прогрессии'},
      {weeks:'7',title:'Рабочая неделя',action:'Сохраняй достигнутую интенсивность без попыток максимального разового подъёма.',check:'Не тренируйся до отказа'},
      {weeks:'8',title:'Разгрузка',action:'Уменьши объём и вес, оцени восстановление перед новым циклом.',check:'Запиши ощущения и результаты'}
    ]},
    en:{heading:'8-week strength progression',introduction:'Good technique and adequate rest come first. Seek coaching when you are unsure of a lift.',phases:[
      {weeks:'1–2',title:'Base sets',action:'Choose conservative weights for 5×5, leaving a clear effort margin.',check:'Repeatable range of motion'},
      {weeks:'3–4',title:'Consistent 5×5',action:'Increase load only after all five sets of five are completed with control.',check:'Allow longer rests between heavy sets'},
      {weeks:'5–6',title:'Check consistency',action:'If form deteriorates, repeat the same load next session rather than adding weight.',check:'Technique matters more than the increment'},
      {weeks:'7',title:'Working week',action:'Maintain your training intensity without testing a one-rep maximum.',check:'Stay clear of training to failure'},
      {weeks:'8',title:'Deload',action:'Reduce both volume and weight, review recovery and plan the next cycle.',check:'Record performance and effort'}
    ]}
  },
  cut5: {
    ru:{heading:'Прогрессия тренировок на рельеф (8 недель)',introduction:'Во время дефицита энергии цель силовых тренировок — сохранить силу и работоспособность, а не добавлять нагрузку любой ценой.',phases:[
      {weeks:'1–2',title:'Исходный объём',action:'Запиши рабочие веса, упражнения, самочувствие и переносимость кардио.',check:'Нагрузка должна позволять восстановление'},
      {weeks:'3–4',title:'Стабильная силовая работа',action:'Сохраняй рабочие веса при хорошей технике; объём кардио повышай постепенно.',check:'Отслеживай сон и восстановление'},
      {weeks:'5–6',title:'Оценка утомления',action:'Если восстановление ухудшается, сократи дополнительное кардио или рабочие подходы.',check:'Избегай сочетания усталости и отказных подходов'},
      {weeks:'7',title:'Контрольная неделя',action:'Сравни выполненные повторения и общее самочувствие с началом цикла.',check:'Избегай резкого роста нагрузки'},
      {weeks:'8',title:'Разгрузка',action:'Снизь общий объём, оцени дальнейшую цель тренинга.',check:'Учитывай индивидуальные ограничения'}
    ]},
    en:{heading:'8-week cutting-phase training progression',introduction:'During an energy deficit, prioritize strength retention and recovery over adding load at all costs.',phases:[
      {weeks:'1–2',title:'Establish baseline',action:'Record loads, exercise completion, effort and cardio tolerance.',check:'Maintain a recoverable workload'},
      {weeks:'3–4',title:'Keep strength consistent',action:'Retain training loads with good form, increasing cardio only gradually.',check:'Track sleep and recovery'},
      {weeks:'5–6',title:'Check fatigue',action:'If recovery worsens, reduce optional cardio or working sets.',check:'Avoid failure sets while very fatigued'},
      {weeks:'7',title:'Review week',action:'Compare your completed reps and overall energy with the start of the cycle.',check:'Avoid abrupt workload jumps'},
      {weeks:'8',title:'Deload',action:'Reduce overall training volume and reassess your next goal.',check:'Respect individual limits'}
    ]}
  },
  home3: {
    ru:{heading:'Прогрессия домашних тренировок на 8 недель',introduction:'Выбирай безопасные варианты движений с устойчивой опорой; качество повторений важнее скорости.',phases:[
      {weeks:'1–2',title:'Освоение движений',action:'Начни с комфортного количества повторений и упрощённых вариантов упражнений.',check:'Контроль движения без боли'},
      {weeks:'3–4',title:'Добавление повторений',action:'Постепенно увеличь по 1–2 повтора, если все подходы выполняются уверенно.',check:'Сохраняй диапазон движения'},
      {weeks:'5–6',title:'Усложнение варианта',action:'При лёгком выполнении упражнений используй немного более сложный вариант.',check:'Усложняй только одно движение за раз'},
      {weeks:'7',title:'Закрепление',action:'Повтори уровень прошлой недели и оцени качество техники.',check:'Не гонись за количеством'},
      {weeks:'8',title:'Облегчённая неделя',action:'Сократи подходы, затем выбери следующий цикл по результатам.',check:'Отслеживай восстановление'}
    ]},
    en:{heading:'8-week home-workout progression',introduction:'Choose safe, stable movement options; rep quality matters more than speed.',phases:[
      {weeks:'1–2',title:'Learn movement patterns',action:'Start at a comfortable rep count with simplified exercise variants.',check:'Controlled, pain-free motion'},
      {weeks:'3–4',title:'Add repetitions',action:'Add 1–2 reps gradually if all sets are consistently controlled.',check:'Maintain a comfortable range of motion'},
      {weeks:'5–6',title:'Progress an exercise variant',action:'When an exercise becomes easy, choose a slightly more challenging version.',check:'Change only one movement at a time'},
      {weeks:'7',title:'Consolidate',action:'Repeat last week’s level and review form.',check:'Quality over total repetitions'},
      {weeks:'8',title:'Ease off',action:'Reduce sets and choose the next cycle based on your progress.',check:'Monitor recovery'}
    ]}
  },
  women3: {
    ru:{heading:'Прогрессия тренировки на 8 недель',introduction:'Нагрузка подбирается по подготовке и технике, а не по полу. Используй комфортный диапазон движений.',phases:[
      {weeks:'1–2',title:'База и техника',action:'Подбери упражнения с устойчивой техникой, запиши веса и повторения.',check:'Оставляй повторы в запасе'},
      {weeks:'3–4',title:'Укрепление привычки',action:'Стремись к постепенному росту повторений, не сокращая контроль в упражнениях.',check:'Контролируй амплитуду'},
      {weeks:'5–6',title:'Постепенное увеличение',action:'Если верх диапазона повторений стабилен, увеличь нагрузку маленьким шагом.',check:'Следи за восстановлением'},
      {weeks:'7',title:'Закрепление',action:'Повтори рабочие веса и оцени ощущения после тренировки.',check:'Избегай резкой прогрессии'},
      {weeks:'8',title:'Разгрузка',action:'Сократи рабочие подходы и оцени следующее направление.',check:'Двигайся без боли'}
    ]},
    en:{heading:'8-week training progression',introduction:'Load selection depends on preparation and technique, not gender. Use a comfortable range of motion.',phases:[
      {weeks:'1–2',title:'Foundation and form',action:'Select exercises with stable technique and log your weights and reps.',check:'Leave reps in reserve'},
      {weeks:'3–4',title:'Build consistency',action:'Increase reps gradually without sacrificing exercise control.',check:'Maintain range of motion'},
      {weeks:'5–6',title:'Small progressions',action:'If you consistently hit the upper rep target, increase load in small steps.',check:'Pay attention to recovery'},
      {weeks:'7',title:'Consolidate',action:'Repeat training loads and review how you feel afterward.',check:'Avoid sudden increases'},
      {weeks:'8',title:'Deload',action:'Reduce working sets and review your next goal.',check:'Move without pain'}
    ]}
  },
  senior3: {
    ru:{heading:'Щадящая прогрессия на 8 недель',introduction:'Информация не заменяет медицинский совет. При хронических заболеваниях, травмах или недавней операции обсуди нагрузки с врачом.',phases:[
      {weeks:'1–2',title:'Лёгкое начало',action:'Выбери комфортный темп и устойчивые варианты движений. При необходимости уменьши повторы.',check:'Не допускай боли, головокружения и одышки'},
      {weeks:'3–4',title:'Регулярность',action:'Удерживай частоту лёгких занятий; улучшай качество движений без добавления веса.',check:'Сохраняй возможность говорить во время кардио'},
      {weeks:'5–6',title:'Малые изменения',action:'При хорошем самочувствии добавь немного времени ходьбы или 1–2 повторения.',check:'Без резкого роста нагрузки'},
      {weeks:'7',title:'Оценка переносимости',action:'Сравни самочувствие до и после тренировок, скорректируй нагрузку.',check:'Делай паузы при усталости'},
      {weeks:'8',title:'Лёгкая неделя',action:'Снизь нагрузку и обсуди дальнейшие цели со специалистом при необходимости.',check:'Безопасность важнее интенсивности'}
    ]},
    en:{heading:'Gentle 8-week progression',introduction:'Educational guidance, not medical advice. Discuss exercise with a clinician when living with chronic illness, injury or recent surgery.',phases:[
      {weeks:'1–2',title:'Start gently',action:'Choose a comfortable pace and stable movements; reduce reps as needed.',check:'Stop with pain, dizziness or unusual breathlessness'},
      {weeks:'3–4',title:'Build consistency',action:'Keep a regular easy routine and focus on movement quality rather than extra weight.',check:'You should be able to talk during cardio'},
      {weeks:'5–6',title:'Small additions',action:'If well tolerated, add a little walking time or 1–2 reps.',check:'Avoid sudden workload changes'},
      {weeks:'7',title:'Review tolerance',action:'Compare how you feel before and after sessions and adjust the workload.',check:'Rest when fatigued'},
      {weeks:'8',title:'Easy week',action:'Lower intensity and discuss next goals with a professional if needed.',check:'Safety before intensity'}
    ]}
  }
});

export const progressionIds = Object.freeze(Object.keys(progressions));
export function getPremiumProgramProgression(programId,lang='ru'){
  if(typeof programId!=='string' || !Object.hasOwn(progressions,programId))return null;
  const locale=lang==='en'?'en':'ru';
  const data=progressions[programId][locale];
  return {
    programId,
    language:locale,
    heading:data.heading,
    introduction:data.introduction,
    phases:data.phases.map(phase=>({...phase})),
    disclaimer:locale==='ru'
      ?'Образовательные рекомендации. При боли, травмах или заболеваниях обратитесь к специалисту.'
      :'Educational guidance. Consult a qualified professional if you have pain, injury or a medical condition.'
  };
}
