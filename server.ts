import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  getDb,
  getAllUsers,
  getUserById,
  getUserByEmail,
  findOrCreateGoogleUser,
  createUser,
  getPlansForUser,
  getCurrentPlanForUser,
  savePlan,
  addNutritionTipToPlan,
  updateCoachNotes,
  deleteUserAndPlans,
} from './server/db.js';
import {
  generateAIFitnessPlan,
  regenerateAIPlanWithFeedback,
  generateAINutritionTip,
} from './server/gemini.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Enable CORS for all origins, methods, and headers
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Initialize SQLite database on boot
getDb()
  .then(() => console.log('SQLite fitbuddy.db connected and tables initialized'))
  .catch((err) => console.error('Database initialization error:', err));

// ================= API ROUTES =================

// Google Authentication Endpoint
app.post('/api/auth/google', async (req: Request, res: Response) => {
  try {
    const { email, name, picture_url, google_id } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required for Google Sign-In.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await findOrCreateGoogleUser({
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      picture_url: picture_url || '',
      google_id: google_id || '',
    });

    const plans = await getPlansForUser(user.id);
    const currentPlan = plans.find((p) => p.is_current === 1) || plans[0] || null;

    res.json({
      success: true,
      user,
      plans,
      currentPlan,
    });
  } catch (err: any) {
    console.error('Google Auth Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get current authenticated user by email or ID
app.get('/api/auth/me', async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string;
    const id = req.query.id as string;

    let user = null;
    if (email) {
      user = await getUserByEmail(email);
    } else if (id) {
      user = await getUserById(Number(id));
    }

    if (!user) {
      return res.status(404).json({ success: false, error: 'User session not found.' });
    }

    const plans = await getPlansForUser(user.id);
    const currentPlan = plans.find((p) => p.is_current === 1) || plans[0] || null;

    res.json({
      success: true,
      user,
      plans,
      currentPlan,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function formatPlanText(plan: any): string {
  if (!plan) return 'N/A';
  let out = `## ${plan.plan_name}\n\n`;
  if (plan.summary) out += `${plan.summary}\n\n`;
  if (plan.feedback_applied) out += `* Feedback Applied: "${plan.feedback_applied}"\n\n`;
  if (Array.isArray(plan.schedule)) {
    plan.schedule.forEach((day: any) => {
      out += `**${day.day_name || `Day ${day.day_number}`}**: ${day.title || day.focus}\n`;
      if (day.is_rest_day) {
        out += `  * Rest & Active Recovery Day\n`;
      } else {
        if (day.warm_up && day.warm_up.length) {
          out += `  * Warm-up (5-10 mins): ${day.warm_up.join(', ')}\n`;
        }
        if (day.exercises && day.exercises.length) {
          out += `  * Main Workout:\n`;
          day.exercises.forEach((ex: any) => {
            out += `    - ${ex.name}: ${ex.sets} sets x ${ex.reps} reps (Rest: ${ex.rest})\n`;
          });
        }
        if (day.cool_down && day.cool_down.length) {
          out += `  * Cooldown: ${day.cool_down.join(', ')}\n`;
        }
      }
      out += `\n`;
    });
  }
  return out.trim();
}

// Scenario 4: List all registered users (Coach/Admin Dashboard)
app.get('/api/users', async (req: Request, res: Response) => {
  try {
    const users = await getAllUsers();
    // Attach current plan summary, original_plan, and updated_plan matching PDF specification
    const usersWithMeta = await Promise.all(
      users.map(async (u) => {
        const plans = await getPlansForUser(u.id);
        const originalPlan = plans.find((p) => p.version === 1) || plans[0] || null;
        const updatedPlan = plans.find((p) => p.version > 1) || null;
        const currentPlan = plans.find((p) => p.is_current === 1) || plans[0] || null;
        return {
          ...u,
          plan_count: plans.length,
          current_version: currentPlan ? currentPlan.version : 0,
          current_plan_name: currentPlan ? currentPlan.plan_name : 'No Plan Yet',
          has_feedback_revision: !!updatedPlan,
          original_plan: formatPlanText(originalPlan),
          updated_plan: updatedPlan ? formatPlanText(updatedPlan) : 'Not updated',
          last_activity: currentPlan ? currentPlan.created_at : u.created_at,
        };
      })
    );
    res.json({ success: true, users: usersWithMeta });
  } catch (err: any) {
    console.error('Error fetching users:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PDF Route: /view-all-users
app.get('/view-all-users', async (req: Request, res: Response) => {
  try {
    const users = await getAllUsers();
    const user_data = await Promise.all(
      users.map(async (u) => {
        const plans = await getPlansForUser(u.id);
        const originalPlan = plans.find((p) => p.version === 1) || plans[0] || null;
        const updatedPlan = plans.find((p) => p.version > 1) || null;
        return {
          id: u.id,
          name: u.name,
          age: u.age,
          weight: u.weight,
          goal: u.fitness_goal,
          intensity: u.workout_intensity,
          original_plan: formatPlanText(originalPlan),
          updated_plan: updatedPlan ? formatPlanText(updatedPlan) : 'Not updated',
        };
      })
    );
    res.json({ success: true, users: user_data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get user profile + all plans
app.get('/api/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const plans = await getPlansForUser(userId);
    res.json({ success: true, user, plans });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scenario 1: Generate personalized 7-day workout plan
app.post('/api/plans/generate', async (req: Request, res: Response) => {
  try {
    const {
      user_id,
      email,
      picture_url,
      google_id,
      name,
      age,
      weight,
      weight_unit = 'kg',
      fitness_goal,
      workout_intensity,
      experience_level = 'intermediate',
      equipment = 'gym',
      health_notes = '',
    } = req.body;

    if (!name || !age || !weight || !fitness_goal || !workout_intensity) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, age, weight, fitness_goal, workout_intensity are required.',
      });
    }

    // Save or register user in SQLite users table
    const newUser = await createUser({
      name,
      email: email || undefined,
      picture_url: picture_url || undefined,
      google_id: google_id || undefined,
      age: Number(age),
      weight: Number(weight),
      weight_unit,
      fitness_goal,
      workout_intensity,
      experience_level,
      equipment,
      health_notes,
    });

    const userToUse = newUser || {
      id: user_id ? Number(user_id) : Date.now(),
      name,
      email,
      picture_url,
      google_id,
      age: Number(age),
      weight: Number(weight),
      weight_unit,
      fitness_goal,
      workout_intensity,
      experience_level,
      equipment,
      health_notes,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    console.log(`[Scenario 1] Generating AI Workout Plan for ${userToUse.name} (${userToUse.fitness_goal}, ${userToUse.workout_intensity} intensity)...`);

    // Call Gemini Model
    const aiResult = await generateAIFitnessPlan({
      name: userToUse.name,
      age: userToUse.age,
      weight: userToUse.weight,
      weight_unit: userToUse.weight_unit,
      fitness_goal: userToUse.fitness_goal,
      workout_intensity: userToUse.workout_intensity,
      experience_level: userToUse.experience_level,
      equipment: userToUse.equipment,
      health_notes: userToUse.health_notes,
    });

    // Initial goal-oriented nutrition tip
    const initialTip = await generateAINutritionTip({
      fitness_goal: userToUse.fitness_goal,
      workout_intensity: userToUse.workout_intensity,
      user_name: userToUse.name,
      weight: userToUse.weight,
      weight_unit: userToUse.weight_unit,
      category: 'Post-Workout Fuel',
    });

    // Save to plans table in fitbuddy.db as Version 1
    const savedPlan = await savePlan({
      user_id: userToUse.id,
      version: 1,
      plan_name: aiResult.plan_name,
      summary: aiResult.summary,
      target_goal: userToUse.fitness_goal,
      intensity: userToUse.workout_intensity,
      feedback_applied: undefined,
      schedule: aiResult.schedule,
      nutrition_tips: [initialTip],
      coach_notes: '',
    });

    res.json({
      success: true,
      user: userToUse,
      plan: savedPlan,
    });
  } catch (err: any) {
    console.error('Error generating workout plan:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PDF Specification Route: /generate-workout
app.post('/generate-workout', async (req: Request, res: Response) => {
  // Supports form-encoded and JSON body
  try {
    const { username, name, user_id, age, weight, goal, fitness_goal, intensity, workout_intensity } = req.body;
    req.body.name = name || username || 'Athlete';
    req.body.user_id = user_id;
    req.body.age = age || 25;
    req.body.weight = weight || 70;
    req.body.fitness_goal = fitness_goal || goal || 'muscle gain';
    req.body.workout_intensity = workout_intensity || intensity || 'medium';

    // Call standard generator
    const newUser = await createUser({
      name: req.body.name,
      age: Number(req.body.age),
      weight: Number(req.body.weight),
      weight_unit: 'kg',
      fitness_goal: req.body.fitness_goal,
      workout_intensity: req.body.workout_intensity,
      experience_level: 'intermediate',
      equipment: 'Commercial Gym',
      health_notes: '',
    });

    const aiResult = await generateAIFitnessPlan({
      name: newUser.name,
      age: newUser.age,
      weight: newUser.weight,
      weight_unit: newUser.weight_unit,
      fitness_goal: newUser.fitness_goal,
      workout_intensity: newUser.workout_intensity,
    });

    const initialTip = await generateAINutritionTip({
      fitness_goal: newUser.fitness_goal,
      workout_intensity: newUser.workout_intensity,
      user_name: newUser.name,
      weight: newUser.weight,
      weight_unit: newUser.weight_unit,
      category: 'Nutrition Tip',
    });

    const savedPlan = await savePlan({
      user_id: newUser.id,
      version: 1,
      plan_name: aiResult.plan_name,
      summary: aiResult.summary,
      target_goal: newUser.fitness_goal,
      intensity: newUser.workout_intensity,
      feedback_applied: undefined,
      schedule: aiResult.schedule,
      nutrition_tips: [initialTip],
      coach_notes: '',
    });

    res.json({
      success: true,
      message: 'Workout plan generated and saved successfully!',
      user: newUser,
      workout_plan: formatPlanText(savedPlan),
      nutrition_tip: initialTip.tip,
      plan: savedPlan,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PDF Specification Route: /submit-feedback
app.post('/submit-feedback', async (req: Request, res: Response) => {
  try {
    const user_id = Number(req.body.user_id || req.body.userId);
    const feedback = req.body.feedback || req.body.user_feedback || req.body.feedback_text;

    if (!user_id || !feedback) {
      return res.status(400).json({ error: 'user_id and feedback are required' });
    }

    const user = await getUserById(user_id);
    if (!user) {
      return res.status(404).json({ error: 'Original plan not found for this user.' });
    }

    const plans = await getPlansForUser(user_id);
    const basePlan = plans.find((p) => p.is_current === 1) || plans[0];
    if (!basePlan) {
      return res.status(404).json({ error: 'Original plan not found for this user.' });
    }

    const nextVersion = (basePlan.version || 1) + 1;
    const updatedAiResult = await regenerateAIPlanWithFeedback(
      user,
      basePlan,
      feedback
    );

    const updatedPlan = await savePlan({
      user_id: user.id,
      version: nextVersion,
      plan_name: updatedAiResult.plan_name,
      summary: updatedAiResult.summary,
      target_goal: user.fitness_goal,
      intensity: user.workout_intensity,
      feedback_applied: feedback,
      schedule: updatedAiResult.schedule,
      nutrition_tips: basePlan.nutrition_tips || [],
      coach_notes: basePlan.coach_notes || '',
    });

    res.json({
      success: true,
      message: 'Your plan has been updated based on your feedback!',
      updated_plan: formatPlanText(updatedPlan),
      original_plan: formatPlanText(basePlan),
      plan: updatedPlan,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PDF Specification Route: /nutrition-tip
app.get('/nutrition-tip', async (req: Request, res: Response) => {
  try {
    const goal = (req.query.goal as string) || 'muscle gain';
    const tip = await generateAINutritionTip({
      fitness_goal: goal,
      workout_intensity: 'medium',
      category: 'Nutrition Tip',
      user_name: 'Athlete',
      weight: 70,
      weight_unit: 'kg',
    });
    res.json({ goal, nutrition_tip: tip.tip, tip_object: tip });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scenario 2: Regenerate updated workout plan based on user feedback
app.post('/api/plans/regenerate', async (req: Request, res: Response) => {
  try {
    const { userId, planId, feedback } = req.body;

    if (!userId || !feedback || feedback.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'userId and feedback are required to regenerate a plan.',
      });
    }

    const user = await getUserById(Number(userId));
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const plans = await getPlansForUser(user.id);
    const basePlan = planId ? plans.find((p) => p.id === Number(planId)) : plans.find((p) => p.is_current === 1) || plans[0];

    if (!basePlan) {
      return res.status(404).json({ success: false, error: 'No existing workout plan found to regenerate.' });
    }

    console.log(`[Scenario 2] Regenerating AI Plan for user ${user.name} with feedback: "${feedback}"`);

    // Call Gemini Model to regenerate plan with feedback loop
    const updatedAiResult = await regenerateAIPlanWithFeedback(
      {
        name: user.name,
        age: user.age,
        weight: user.weight,
        weight_unit: user.weight_unit,
        fitness_goal: user.fitness_goal,
        workout_intensity: user.workout_intensity,
      },
      {
        plan_name: basePlan.plan_name,
        summary: basePlan.summary,
        schedule: basePlan.schedule,
      },
      feedback
    );

    const nextVersion = Math.max(...plans.map((p) => p.version), 0) + 1;

    // Save as new version in fitbuddy.db
    const updatedPlan = await savePlan({
      user_id: user.id,
      version: nextVersion,
      plan_name: updatedAiResult.plan_name,
      summary: updatedAiResult.summary,
      target_goal: user.fitness_goal,
      intensity: user.workout_intensity,
      feedback_applied: feedback,
      schedule: updatedAiResult.schedule,
      nutrition_tips: basePlan.nutrition_tips || [],
      coach_notes: basePlan.coach_notes || '',
    });

    res.json({
      success: true,
      user,
      plan: updatedPlan,
      previousPlan: basePlan,
    });
  } catch (err: any) {
    console.error('Error regenerating plan:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scenario 3: Request nutrition or recovery tip
app.post('/api/plans/nutrition-tip', async (req: Request, res: Response) => {
  try {
    const { userId, planId, category } = req.body;

    let fitness_goal = 'muscle gain';
    let workout_intensity = 'medium';
    let user_name = 'Athlete';
    let weight = 70;
    let weight_unit = 'kg';

    if (userId) {
      const user = await getUserById(Number(userId));
      if (user) {
        fitness_goal = user.fitness_goal;
        workout_intensity = user.workout_intensity;
        user_name = user.name;
        weight = user.weight;
        weight_unit = user.weight_unit;
      }
    }

    console.log(`[Scenario 3] Generating nutrition tip for goal: ${fitness_goal}, category: ${category}`);

    const tip = await generateAINutritionTip({
      fitness_goal,
      workout_intensity,
      category,
      user_name,
      weight,
      weight_unit,
    });

    if (planId) {
      await addNutritionTipToPlan(Number(planId), tip);
    }

    res.json({ success: true, tip });
  } catch (err: any) {
    console.error('Error generating nutrition tip:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scenario 4: Get plans for comparison (Original vs Updated)
app.get('/api/plans/user/:userId', async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    const plans = await getPlansForUser(userId);
    const user = await getUserById(userId);
    res.json({ success: true, user, plans });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scenario 4: Coach adds note or endorsement
app.post('/api/admin/coach-notes', async (req: Request, res: Response) => {
  try {
    const { planId, notes } = req.body;
    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId required' });
    }
    await updateCoachNotes(Number(planId), notes || '');
    res.json({ success: true, message: 'Coach notes updated' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Delete User
app.delete('/api/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    await deleteUserAndPlans(userId);
    res.json({ success: true, message: `User ${userId} and associated plans deleted.` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Architecture information endpoint reflecting the system diagram
app.get('/api/architecture', (req: Request, res: Response) => {
  res.json({
    architecture: {
      client: 'Browser (React 19 + Tailwind CSS + Motion)',
      backend: 'Express / Node.js Engine (matching FastAPI / routes.py specification)',
      model: 'Gemini 3.8 Flash (@google/genai)',
      database: 'SQLite (fitbuddy.db)',
      tables: ['users', 'plans'],
      scenariosSupported: [
        'Scenario 1: Personal Intake & 7-Day Workout Plan Generation',
        'Scenario 2: Feedback Loop & Dynamic Plan Regeneration',
        'Scenario 3: Goal-Specific Nutrition & Recovery Tips Generator',
        'Scenario 4: Coach/Admin Oversight Dashboard & Version Comparison',
      ],
    },
  });
});

// ================= FRONTEND / VITE INTEGRATION =================
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
} else {
  // In development, mount Vite's dev server middleware
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FitBuddy Server running on port ${PORT}`);
});
